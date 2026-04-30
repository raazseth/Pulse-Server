import { randomUUID } from "crypto";
import { z } from "zod";
import OpenAI from "openai";
import { logger } from "@/internal/pkg/logger";
import { PromptSuggestion, SessionContext, TranscriptEntry } from "@/internal/domain/hud/model/hud.model";

const SuggestionArraySchema = z.array(
  z.object({ title: z.string(), text: z.string() }),
);

/** Mic / candidate side — AI refreshes when these lines arrive. System/tab audio = call context. */
const INTERVIEWEE_SPEAKER_IDS = new Set(
  [
    "interviewee",
    "candidate",
    "guest",
    "participant",
    "observer",
    "mic",
    "me",
    "self",
    "speaker-1",
  ].map((s) => s.toLowerCase()),
);

export function isIntervieweeSpeakerId(speakerId: string): boolean {
  return INTERVIEWEE_SPEAKER_IDS.has(speakerId.trim().toLowerCase());
}

export function shouldTriggerSuggestionAi(speakerId: string): boolean {
  const s = speakerId.trim().toLowerCase();
  if (s === "system") return false;
  return isIntervieweeSpeakerId(speakerId) || s === "interviewer";
}

function transcriptRoleLabel(speakerId: string): "INTERVIEWEE" | "INTERVIEWER" {
  return isIntervieweeSpeakerId(speakerId) ? "INTERVIEWEE" : "INTERVIEWER";
}

function formatTranscriptForAi(entries: TranscriptEntry[]): string {
  return entries
    .map((e) => `[${transcriptRoleLabel(e.speakerId)}]: ${e.text}`)
    .join("\n");
}

/** Split recent lines for the system prompt (entry ids preserved for grounding). */
export function buildRoleTranscriptDigests(entries: TranscriptEntry[]): {
  interviewer: string;
  interviewee: string;
} {
  const iv: string[] = [];
  const ie: string[] = [];
  for (const e of entries) {
    const id = e.id?.trim() || "";
    const prefix = id ? `[id=${id}] ` : "";
    const line = `${prefix}${e.text}`.trim();
    if (isIntervieweeSpeakerId(e.speakerId)) ie.push(line);
    else iv.push(line);
  }
  const cap = (lines: string[], maxChars: number) => {
    const s = lines.join("\n");
    if (s.length <= maxChars) return s;
    return s.slice(-maxChars);
  };
  return {
    interviewer: cap(iv, 3200),
    interviewee: cap(ie, 3200),
  };
}

export interface SuggestionGenerationInput {
  sessionId: string;
  recentTranscript: TranscriptEntry[];
  context?: SessionContext;
  triggerSpeakerId?: string;
  anchorTranscriptId?: string;
}

function transcriptIdsForAnchors(recent: TranscriptEntry[], anchorTranscriptId?: string): string[] {
  const aid = anchorTranscriptId?.trim();
  if (aid) {
    const i = recent.findIndex((e) => e.id === aid);
    if (i >= 0) {
      const ids = [aid];
      if (i > 0) ids.unshift(recent[i - 1]!.id);
      return ids;
    }
  }
  const last = recent[recent.length - 1];
  if (!last) return [];
  const ids = [last.id];
  if (recent.length >= 2) {
    const prev = recent[recent.length - 2]!;
    if (prev.id !== last.id) ids.unshift(prev.id);
  }
  return ids;
}

export interface AIProvider {
  generateSuggestions(input: SuggestionGenerationInput): Promise<PromptSuggestion[]>;
}

function buildSystemPrompt(
  context?: SessionContext,
  digests?: { interviewer: string; interviewee: string },
): string {
  const studyTitle = context?.title?.trim();
  const facilitator = context?.facilitator?.trim();
  const audience = context?.audience?.trim();
  const role = context?.role?.trim();
  const company = context?.company?.trim();
  const focusNotes = context?.notes?.trim();

  const interviewerBlock =
    digests?.interviewer && digests.interviewer.trim().length > 0
      ? digests.interviewer.trim()
      : "(No recent call / system-audio lines in the window.)";
  const intervieweeBlock =
    digests?.interviewee && digests.interviewee.trim().length > 0
      ? digests.interviewee.trim()
      : "(No recent mic lines in the window.)";

  return [
    "You are an expert live interview coach on the candidate’s side. Your job is to help them perform at their best—anticipate what might come next, tighten their framing, and surface angles so they can answer with clarity and confidence. You are not pitting them against anyone; you are helping them prepare and succeed.",
    "They hear the conversation on the call through system/tab-captured audio (tagged INTERVIEWER in the transcript) and their own voice is captured on the microphone (tagged INTERVIEWEE). Use both channels as context; never invent facts. Prefer concrete probes, trade-offs, and evidence over generic prompts.",
    studyTitle ? `Session / study title: ${studyTitle}.` : "",
    facilitator ? `Other party on the call / system audio (label): ${facilitator}.` : "",
    audience ? `Audience / cohort: ${audience}.` : "",
    role ? `Their role or lens (on mic): ${role}.` : "",
    company ? `Company: ${company}.` : "",
    focusNotes ? `Extra focus for this session: ${focusNotes}.` : "",
    "Below: two digests—call/system audio (INTERVIEWER) and their mic (INTERVIEWEE). Use both; attribute claims only to the channel that said them.",
    "Recent call / system-audio (INTERVIEWER) lines:",
    interviewerBlock,
    "",
    "Recent mic (INTERVIEWEE) lines:",
    intervieweeBlock,
    "",
    "Output up to 3 concise coaching items: sharp follow-ups or topics they should be ready for (often questions that may come from the conversation on the call), each grounded in what they actually said on the mic. One sentence each.",
    'Return ONLY valid JSON, no markdown: [{"title":"short label","text":"the full question"}]',
  ]
    .filter(Boolean)
    .join(" ");
}

function buildUserPromptForSuggestions(
  recent: TranscriptEntry[],
  triggerSpeakerId?: string,
): string {
  const transcriptText = formatTranscriptForAi(recent);
  const t = triggerSpeakerId?.trim();
  const anchor =
    t && isIntervieweeSpeakerId(t)
      ? "The newest transcript chunk is from the INTERVIEWEE — weight that utterance heavily."
      : "Anchor questions on the latest things the INTERVIEWEE said in the snippet below.";
  return [
    "Transcript (INTERVIEWER = system/tab-captured call audio, INTERVIEWEE = user’s microphone):",
    transcriptText,
    "",
    anchor,
    "",
    "Respond with exactly 3 JSON objects: follow-up questions for the INTERVIEWER, grounded in the INTERVIEWEE lines.",
  ].join("\n");
}

function stripMarkdown(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

function buildSuggestions(
  parsed: Array<{ title: string; text: string }>,
  sessionId: string,
  recent: TranscriptEntry[],
  anchorTranscriptId?: string,
): PromptSuggestion[] {
  const now = new Date().toISOString();
  const transcriptIds = transcriptIdsForAnchors(recent, anchorTranscriptId);
  return parsed.slice(0, 3).map((item) => ({
    id: randomUUID(),
    sessionId,
    title: String(item.title),
    text: String(item.text),
    timestamp: now,
    transcriptIds,
    suggestionOrigin: "model" as const,
  }));
}

export type OpenAIProviderOptions = {
  /** OpenAI chat model id (default gpt-4o-mini). */
  model?: string;
  /** Client HTTP timeout in ms (default 7000). */
  timeoutMs?: number;
};

function previewForLog(text: string, max = 700): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}… (${t.length} chars total)`;
}

export class OpenAIProvider implements AIProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fallback = new RuleBasedAIProvider();

  constructor(apiKey: string, options?: OpenAIProviderOptions) {
    this.timeoutMs = options?.timeoutMs ?? 7000;
    this.client = new OpenAI({ apiKey, timeout: this.timeoutMs });
    this.model = options?.model?.trim() || "gpt-4o-mini";
  }

  async generateSuggestions(input: SuggestionGenerationInput): Promise<PromptSuggestion[]> {
    const t0 = Date.now();
    try {
      const recent = input.recentTranscript.slice(-8);
      const digests = buildRoleTranscriptDigests(recent);
      const systemContent = buildSystemPrompt(input.context, digests);
      const userContent = buildUserPromptForSuggestions(recent, input.triggerSpeakerId);
      const promptChars = systemContent.length + userContent.length;

      logger.info(
        `HUD AI ▸ OpenAI request [session=${input.sessionId}] model=${this.model} ` +
          `recentLines=${recent.length} promptChars≈${promptChars} timeoutMs=${this.timeoutMs}`,
      );

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userContent },
        ],
        max_tokens: 300,
        temperature: 0.55,
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) throw new Error("Empty OpenAI response");

      const ms = Date.now() - t0;
      const usage = response.usage;
      const usageStr = usage
        ? `prompt_tokens=${usage.prompt_tokens} completion_tokens=${usage.completion_tokens} total=${usage.total_tokens}`
        : "usage=n/a";

      logger.info(
        `HUD AI ▸ OpenAI response [session=${input.sessionId}] model=${this.model} ` +
          `ms=${ms} ${usageStr} finish_reason=${response.choices[0]?.finish_reason ?? "n/a"} ` +
          `body=${previewForLog(raw)}`,
      );

      const result = SuggestionArraySchema.safeParse(JSON.parse(stripMarkdown(raw)));
      if (!result.success) throw new Error("Invalid OpenAI response shape");

      return buildSuggestions(result.data, input.sessionId, recent, input.anchorTranscriptId);
    } catch (err) {
      const ms = Date.now() - t0;
      logger.warn(
        `HUD AI ▸ OpenAI error [session=${input.sessionId}] model=${this.model} ms=${ms} ` +
          `fallback=rule-based — ${err instanceof Error ? err.message : String(err)}`,
      );
      const fallback = await this.fallback.generateSuggestions(input);
      logger.info(
        `HUD AI ▸ OpenAI fallback complete [session=${input.sessionId}] suggestions=${fallback.length}`,
      );
      return fallback;
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

  async generateSuggestions(input: SuggestionGenerationInput): Promise<PromptSuggestion[]> {
    if (Date.now() < this.backoffUntil) {
      logger.info(
        `HUD AI ▸ Gemini skipped (backoff) [session=${input.sessionId}] → rule-based`,
      );
      return this.fallback.generateSuggestions(input);
    }

    const t0 = Date.now();
    try {
      const recent = input.recentTranscript.slice(-8);
      const digests = buildRoleTranscriptDigests(recent);
      const userMessage = `${buildSystemPrompt(input.context, digests)}\n\n${buildUserPromptForSuggestions(recent, input.triggerSpeakerId)}`;

      logger.info(
        `HUD AI ▸ Gemini request [session=${input.sessionId}] promptChars≈${userMessage.length}`,
      );

      const body = {
        contents: [
          { role: "user", parts: [{ text: userMessage }] },
        ],
        generationConfig: { temperature: 0.55, maxOutputTokens: 320 },
      };

      const res = await fetch(`${this.endpoint}?key=${this.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(7_000),
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
      const ms = Date.now() - t0;
      logger.info(
        `HUD AI ▸ Gemini response [session=${input.sessionId}] ms=${ms} ` +
          `body=${previewForLog(raw)}`,
      );
      return buildSuggestions(parsed.data, input.sessionId, recent, input.anchorTranscriptId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const paused = Date.now() < this.backoffUntil;
      const ms = Date.now() - t0;
      logger.warn(
        `HUD AI ▸ Gemini error [session=${input.sessionId}] ms=${ms} fallback=rule-based: ${msg}` +
          (paused ? " (Gemini HTTP paused ~5 min after 4xx — check GEMINI_API_KEY / GEMINI_MODEL)" : ""),
      );
      const fallback = await this.fallback.generateSuggestions(input);
      logger.info(
        `HUD AI ▸ Gemini fallback complete [session=${input.sessionId}] suggestions=${fallback.length}`,
      );
      return fallback;
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
  return `Prep a stronger answer${audience}—practice responding to: "${trimmed}"`;
}

export class RuleBasedAIProvider implements AIProvider {
  async generateSuggestions(input: SuggestionGenerationInput): Promise<PromptSuggestion[]> {
    const t0 = Date.now();
    const now = new Date().toISOString();
    const seeds = input.recentTranscript.slice(-5);
    const fallbackIds = transcriptIdsForAnchors(seeds, input.anchorTranscriptId);
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

    const fb = fallbackIds.length ? fallbackIds : seeds.length ? [seeds[seeds.length - 1]!.id] : [];
    const fallbackPrompts: PromptSuggestion[] = [
      {
        id: randomUUID(),
        sessionId: input.sessionId,
        title: "Validate with an example",
        text: "Ask for a concrete example that shows how the candidate handled the situation.",
        timestamp: now,
        transcriptIds: fb,
      },
      {
        id: randomUUID(),
        sessionId: input.sessionId,
        title: "Test decision quality",
        text: "Ask what trade-offs were considered before the decision was made.",
        timestamp: now,
        transcriptIds: fb,
      },
      {
        id: randomUUID(),
        sessionId: input.sessionId,
        title: "Check measurable impact",
        text: "Ask how success was measured and what changed after the work shipped.",
        timestamp: now,
        transcriptIds: fb,
      },
    ];

    for (const fallback of fallbackPrompts) {
      if (unique.size >= 3) break;
      if (!unique.has(fallback.title)) {
        unique.set(fallback.title, fallback);
      }
    }

    const out = Array.from(unique.values()).slice(0, 5);
    logger.info(
      `HUD AI ▸ rule-based response [session=${input.sessionId}] ms=${Date.now() - t0} ` +
        `suggestions=${out.length} seedLines=${seeds.length}`,
    );
    return out;
  }
}
