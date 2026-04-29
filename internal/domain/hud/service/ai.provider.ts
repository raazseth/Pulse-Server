import { randomUUID } from "crypto";
import { z } from "zod";
import OpenAI from "openai";
import { logger } from "@/internal/pkg/logger";
import { PromptSuggestion, SessionContext, TranscriptEntry } from "@/internal/domain/hud/model/hud.model";

const SuggestionArraySchema = z.array(
  z.object({ title: z.string(), text: z.string() }),
);

export interface AIProvider {
  generateSuggestions(input: {
    sessionId: string;
    recentTranscript: TranscriptEntry[];
    context?: SessionContext;
    triggerSpeakerId?: string;
  }): Promise<PromptSuggestion[]>;
}

function buildSystemPrompt(context?: SessionContext): string {
  return [
    "You are a real-time interview coach helping an interviewer during a live interview.",
    context?.role ? `The interviewee's role is: ${context.role}.` : "",
    context?.company ? `Company: ${context.company}.` : "",
    context?.notes ? `Interview focus: ${context.notes}.` : "",
    "The interviewee just spoke. Based on what they said, generate up to 3 sharp, specific follow-up questions the interviewer should ask next.",
    "Questions must be grounded in what the interviewee actually said — no generic filler.",
    "Keep each question concise (one sentence). Prioritize depth, specifics, and uncovering reasoning.",
    'Return ONLY a valid JSON array, no markdown, no explanation: [{"title":"short label","text":"the full question"}]',
  ]
    .filter(Boolean)
    .join(" ");
}

function stripMarkdown(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

function buildSuggestions(
  parsed: Array<{ title: string; text: string }>,
  sessionId: string,
  recent: TranscriptEntry[],
): PromptSuggestion[] {
  const now = new Date().toISOString();
  return parsed.slice(0, 3).map((item) => ({
    id: randomUUID(),
    sessionId,
    title: String(item.title),
    text: String(item.text),
    timestamp: now,
    transcriptIds: recent.map((e) => e.id),
    suggestionOrigin: "model" as const,
  }));
}

export type OpenAIProviderOptions = {
  /** OpenAI chat model id (default gpt-4o-mini). */
  model?: string;
};

export class OpenAIProvider implements AIProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly fallback = new RuleBasedAIProvider();

  constructor(apiKey: string, options?: OpenAIProviderOptions) {
    this.client = new OpenAI({ apiKey, timeout: 10_000 });
    this.model = options?.model?.trim() || "gpt-4o-mini";
  }

  async generateSuggestions(input: {
    sessionId: string;
    recentTranscript: TranscriptEntry[];
    context?: SessionContext;
    triggerSpeakerId?: string;
  }): Promise<PromptSuggestion[]> {
    try {
      const recent = input.recentTranscript.slice(-8);
      const transcriptText = recent
        .map((e) => {
          const label = e.speakerId === "system" ? "INTERVIEWEE" : "INTERVIEWER";
          return `[${label}]: ${e.text}`;
        })
        .join("\n");

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: buildSystemPrompt(input.context) },
          { role: "user", content: `Conversation so far:\n${transcriptText}\n\nGenerate 3 follow-up questions for the INTERVIEWER to ask now.` },
        ],
        max_tokens: 500,
        temperature: 0.7,
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) throw new Error("Empty OpenAI response");

      const result = SuggestionArraySchema.safeParse(JSON.parse(stripMarkdown(raw)));
      if (!result.success) throw new Error("Invalid OpenAI response shape");

      return buildSuggestions(result.data, input.sessionId, recent);
    } catch (err) {
      logger.warn(`OpenAI provider failed, using fallback: ${err instanceof Error ? err.message : String(err)}`);
      return this.fallback.generateSuggestions(input);
    }
  }
}

export type GeminiProviderOptions = {
  modelId?: string;
};

export class GeminiProvider implements AIProvider {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fallback = new RuleBasedAIProvider();
  private backoffUntil = 0;

  constructor(apiKey: string, options?: GeminiProviderOptions) {
    this.apiKey = apiKey;
    const model = options?.modelId?.trim() || "gemini-2.5-flash";
    this.endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  }

  async generateSuggestions(input: {
    sessionId: string;
    recentTranscript: TranscriptEntry[];
    context?: SessionContext;
    triggerSpeakerId?: string;
  }): Promise<PromptSuggestion[]> {
    if (Date.now() < this.backoffUntil) {
      return this.fallback.generateSuggestions(input);
    }

    try {
      const recent = input.recentTranscript.slice(-8);
      const transcriptText = recent
        .map((e) => {
          const label = e.speakerId === "system" ? "INTERVIEWEE" : "INTERVIEWER";
          return `[${label}]: ${e.text}`;
        })
        .join("\n");

      const userMessage = `${buildSystemPrompt(input.context)}\n\nConversation so far:\n${transcriptText}\n\nGenerate 3 follow-up questions for the INTERVIEWER to ask now.`;

      const body = {
        contents: [
          { role: "user", parts: [{ text: userMessage }] },
        ],
        generationConfig: { temperature: 0.7, maxOutputTokens: 500 },
      };

      const res = await fetch(`${this.endpoint}?key=${this.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status >= 400 && res.status < 500) {
          this.backoffUntil = Date.now() + 5 * 60 * 1000;
        }
        throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 200)}`);
      }

      const json = await res.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const raw = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) throw new Error("Empty Gemini response");

      const parsed = SuggestionArraySchema.safeParse(JSON.parse(stripMarkdown(raw)));
      if (!parsed.success) throw new Error("Invalid Gemini response shape");

      this.backoffUntil = 0;
      return buildSuggestions(parsed.data, input.sessionId, recent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const paused = Date.now() < this.backoffUntil;
      logger.warn(
        `Gemini provider failed, using fallback: ${msg}` +
          (paused ? " (Gemini HTTP paused ~5 min after 4xx — check GEMINI_API_KEY / GEMINI_MODEL)" : ""),
      );
      return this.fallback.generateSuggestions(input);
    }
  }
}

function buildPromptTitle(text: string) {
  if (/why|how|what/i.test(text)) return "Clarify the reasoning";
  if (/risk|blocker|issue|concern/i.test(text)) return "Probe the risk";
  if (/customer|user|stakeholder/i.test(text)) return "Explore user impact";
  return "Push the answer deeper";
}

function buildPromptBody(text: string, context?: SessionContext) {
  const trimmed = text.length > 120 ? `${text.slice(0, 117)}...` : text;
  const audience = context?.role ? ` for the ${context.role} role` : "";
  return `Ask a sharper follow-up${audience}: "${trimmed}"`;
}

export class RuleBasedAIProvider implements AIProvider {
  async generateSuggestions(input: {
    sessionId: string;
    recentTranscript: TranscriptEntry[];
    context?: SessionContext;
    triggerSpeakerId?: string;
  }): Promise<PromptSuggestion[]> {
    const now = new Date().toISOString();
    const seeds = input.recentTranscript.slice(-5);
    const suggestions = seeds.map((entry) => ({
      id: randomUUID(),
      sessionId: input.sessionId,
      title: buildPromptTitle(entry.text),
      text: buildPromptBody(entry.text, input.context),
      timestamp: now,
      transcriptIds: [entry.id],
    }));

    const unique = new Map<string, PromptSuggestion>();
    for (const suggestion of suggestions) {
      if (!unique.has(suggestion.title)) {
        unique.set(suggestion.title, suggestion);
      }
    }

    const fallbackPrompts: PromptSuggestion[] = [
      {
        id: randomUUID(),
        sessionId: input.sessionId,
        title: "Validate with an example",
        text: "Ask for a concrete example that shows how the candidate handled the situation.",
        timestamp: now,
        transcriptIds: seeds.map((entry) => entry.id),
      },
      {
        id: randomUUID(),
        sessionId: input.sessionId,
        title: "Test decision quality",
        text: "Ask what trade-offs were considered before the decision was made.",
        timestamp: now,
        transcriptIds: seeds.map((entry) => entry.id),
      },
      {
        id: randomUUID(),
        sessionId: input.sessionId,
        title: "Check measurable impact",
        text: "Ask how success was measured and what changed after the work shipped.",
        timestamp: now,
        transcriptIds: seeds.map((entry) => entry.id),
      },
    ];

    for (const fallback of fallbackPrompts) {
      if (unique.size >= 3) break;
      if (!unique.has(fallback.title)) {
        unique.set(fallback.title, fallback);
      }
    }

    return Array.from(unique.values()).slice(0, 5);
  }
}
