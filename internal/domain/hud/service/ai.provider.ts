import { randomUUID } from "crypto";
import { z } from "zod";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "@/internal/pkg/logger";
import { PromptSuggestion, SessionContext, TranscriptEntry } from "@/internal/domain/hud/model/hud.model";

// S-15: Validate AI response shape at runtime
const SuggestionArraySchema = z.array(
  z.object({ title: z.string(), text: z.string() }),
);

export interface AIProvider {
  generateSuggestions(input: {
    sessionId: string;
    recentTranscript: TranscriptEntry[];
    context?: SessionContext;
  }): Promise<PromptSuggestion[]>;
}

function buildSystemPrompt(context?: SessionContext): string {
  return [
    "You assist researchers conducting live qualitative interviews.",
    context?.role ? `The interviewee's role is: ${context.role}.` : "",
    context?.notes ? `Study context: ${context.notes}.` : "",
    "Generate up to 3 short, sharp follow-up prompts the interviewer could ask next.",
    'Return ONLY a JSON array: [{"title":"short label","text":"the full question"}]',
  ]
    .filter(Boolean)
    .join(" ");
}

function buildSuggestions(
  parsed: Array<{ title: string; text: string }>,
  sessionId: string,
  recent: TranscriptEntry[],
): PromptSuggestion[] {
  const now = new Date().toISOString();
  return parsed.slice(0, 5).map((item) => ({
    id: randomUUID(),
    sessionId,
    title: String(item.title),
    text: String(item.text),
    timestamp: now,
    transcriptIds: recent.map((e) => e.id),
  }));
}

// S-05: Timeout (10 s) configured at SDK level via constructor
export class OpenAIProvider implements AIProvider {
  private readonly client: OpenAI;
  private readonly fallback = new RuleBasedAIProvider();

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, timeout: 10_000 });
  }

  async generateSuggestions(input: {
    sessionId: string;
    recentTranscript: TranscriptEntry[];
    context?: SessionContext;
  }): Promise<PromptSuggestion[]> {
    try {
      const recent = input.recentTranscript.slice(-5);
      const transcriptText = recent
        .map((e) => `[${e.speakerId}]: ${e.text}`)
        .join("\n");

      const response = await this.client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: buildSystemPrompt(input.context) },
          { role: "user", content: `Recent transcript:\n${transcriptText}` },
        ],
        max_tokens: 400,
        temperature: 0.7,
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) throw new Error("Empty OpenAI response");

      // S-15: Validate shape before consuming
      const result = SuggestionArraySchema.safeParse(JSON.parse(raw));
      if (!result.success) throw new Error("Invalid OpenAI response shape");

      return buildSuggestions(result.data, input.sessionId, recent);
    } catch (err) {
      logger.warn(`OpenAI provider failed, using fallback: ${err instanceof Error ? err.message : String(err)}`);
      return this.fallback.generateSuggestions(input);
    }
  }
}

// S-03: API key passed via SDK constructor (not URL query string)
// S-05: Timeout passed via requestOptions on each call
export class GeminiProvider implements AIProvider {
  private readonly client: GoogleGenerativeAI;
  private readonly fallback = new RuleBasedAIProvider();
  private readonly modelName = "gemini-2.0-flash";

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async generateSuggestions(input: {
    sessionId: string;
    recentTranscript: TranscriptEntry[];
    context?: SessionContext;
  }): Promise<PromptSuggestion[]> {
    try {
      const recent = input.recentTranscript.slice(-5);
      const transcriptText = recent
        .map((e) => `[${e.speakerId}]: ${e.text}`)
        .join("\n");

      const genModel = this.client.getGenerativeModel({
        model: this.modelName,
        systemInstruction: buildSystemPrompt(input.context),
      });

      const result = await genModel.generateContent(
        {
          contents: [
            {
              role: "user",
              parts: [{ text: `Recent transcript:\n${transcriptText}` }],
            },
          ],
          generationConfig: { temperature: 0.7, maxOutputTokens: 400 },
        },
        { timeout: 10_000 },
      );

      const raw = result.response.text();
      if (!raw) throw new Error("Empty Gemini response");

      // S-15: Validate shape before consuming
      const parsed = SuggestionArraySchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error("Invalid Gemini response shape");

      return buildSuggestions(parsed.data, input.sessionId, recent);
    } catch (err) {
      logger.warn(`Gemini provider failed, using fallback: ${err instanceof Error ? err.message : String(err)}`);
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
