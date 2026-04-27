import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Gemini SDK before importing the provider that uses it
vi.mock("@google/generative-ai");

import { GoogleGenerativeAI } from "@google/generative-ai";
import { GeminiProvider, RuleBasedAIProvider } from "@/internal/domain/hud/service/ai.provider";
import { DefaultTranscriptProvider } from "@/internal/domain/hud/service/transcript.provider";
import { TranscriptEntry } from "@/internal/domain/hud/model/hud.model";

function makeEntry(text: string, id?: string): TranscriptEntry {
  return {
    id: id ?? crypto.randomUUID(),
    sessionId: "test-session",
    text,
    speakerId: "interviewer",
    timestamp: new Date().toISOString(),
  };
}

describe("RuleBasedAIProvider", () => {
  const provider = new RuleBasedAIProvider();
  const sessionId = "sess-unit-test";

  it("returns at most 5 suggestions", async () => {
    const transcript = Array.from({ length: 10 }, (_, i) =>
      makeEntry(`Statement number ${i + 1} about the project.`),
    );
    const suggestions = await provider.generateSuggestions({ sessionId, recentTranscript: transcript });
    expect(suggestions.length).toBeLessThanOrEqual(5);
  });

  it("returns suggestions with required fields", async () => {
    const transcript = [makeEntry("Why did you make that decision?")];
    const suggestions = await provider.generateSuggestions({ sessionId, recentTranscript: transcript });

    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) {
      expect(s.id).toBeTruthy();
      expect(s.sessionId).toBe(sessionId);
      expect(s.title).toBeTruthy();
      expect(s.text).toBeTruthy();
      expect(s.timestamp).toBeTruthy();
    }
  });

  it("picks 'Clarify the reasoning' for why/how/what keywords", async () => {
    const transcript = [makeEntry("Why did you choose that approach?")];
    const suggestions = await provider.generateSuggestions({ sessionId, recentTranscript: transcript });
    const titles = suggestions.map((s) => s.title);
    expect(titles).toContain("Clarify the reasoning");
  });

  it("picks 'Probe the risk' for risk/blocker keywords", async () => {
    const transcript = [makeEntry("There was a significant risk with the rollout.")];
    const suggestions = await provider.generateSuggestions({ sessionId, recentTranscript: transcript });
    const titles = suggestions.map((s) => s.title);
    expect(titles).toContain("Probe the risk");
  });

  it("picks 'Explore user impact' for customer/user keywords", async () => {
    const transcript = [makeEntry("We focused heavily on the customer experience.")];
    const suggestions = await provider.generateSuggestions({ sessionId, recentTranscript: transcript });
    const titles = suggestions.map((s) => s.title);
    expect(titles).toContain("Explore user impact");
  });

  it("returns fallback suggestions for an empty transcript", async () => {
    const suggestions = await provider.generateSuggestions({ sessionId, recentTranscript: [] });
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("includes context role in suggestion text when provided", async () => {
    const transcript = [makeEntry("I worked on the API design.")];
    const suggestions = await provider.generateSuggestions({
      sessionId,
      recentTranscript: transcript,
      context: { role: "Backend Engineer", notes: "" },
    });
    const hasRole = suggestions.some((s) => s.text.includes("Backend Engineer"));
    expect(hasRole).toBe(true);
  });

  it("deduplicates suggestions by title", async () => {
    const transcript = [
      makeEntry("Why A?"),
      makeEntry("Why B?"),
      makeEntry("Why C?"),
    ];
    const suggestions = await provider.generateSuggestions({ sessionId, recentTranscript: transcript });
    const titles = suggestions.map((s) => s.title);
    const unique = new Set(titles);
    expect(unique.size).toBe(titles.length);
  });
});

// ---------------------------------------------------------------------------
// GeminiProvider — uses @google/generative-ai SDK (mocked at module level)
// ---------------------------------------------------------------------------

describe("GeminiProvider", () => {
  const sessionId = "sess-gemini-test";

  const mockGenerateContent = vi.fn();
  const mockGetGenerativeModel = vi.fn();

  beforeEach(() => {
    // Must be a regular function — arrow functions cannot be called with `new`
    vi.mocked(GoogleGenerativeAI).mockImplementation(function (this: Record<string, unknown>) {
      this.getGenerativeModel = mockGetGenerativeModel.mockReturnValue({
        generateContent: mockGenerateContent,
      });
    } as unknown as typeof GoogleGenerativeAI);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function mockGeminiResponse(suggestions: Array<{ title: string; text: string }>) {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => JSON.stringify(suggestions) },
    });
  }

  it("returns suggestions parsed from the Gemini SDK response", async () => {
    mockGeminiResponse([
      { title: "Clarify the decision", text: "Can you walk me through that decision?" },
      { title: "Probe the risk", text: "What were the biggest risks you foresaw?" },
    ]);

    const provider = new GeminiProvider("fake-key");
    const results = await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("We decided to rewrite the service.")],
    });

    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Clarify the decision");
    expect(results[0].sessionId).toBe(sessionId);
    expect(results[0].id).toBeTruthy();
    expect(results[0].timestamp).toBeTruthy();
  });

  it("caps results at 5 even when the SDK returns more", async () => {
    mockGeminiResponse(
      Array.from({ length: 8 }, (_, i) => ({ title: `Prompt ${i}`, text: `Question ${i}` })),
    );

    const provider = new GeminiProvider("fake-key");
    const results = await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("Some context.")],
    });

    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("includes transcript ids from the recent entries", async () => {
    const entry = makeEntry("How did that go?", "entry-abc");
    mockGeminiResponse([{ title: "Follow up", text: "Tell me more." }]);

    const provider = new GeminiProvider("fake-key");
    const results = await provider.generateSuggestions({
      sessionId,
      recentTranscript: [entry],
    });

    expect(results[0].transcriptIds).toContain("entry-abc");
  });

  it("passes context role and notes into the system instruction", async () => {
    mockGenerateContent.mockResolvedValueOnce({ response: { text: () => "[]" } });

    const provider = new GeminiProvider("fake-key");
    await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("Some text.")],
      context: { role: "Engineering Manager", notes: "Focus on team dynamics" },
    });

    // systemInstruction is set on getGenerativeModel, not on generateContent
    const modelOptions = mockGetGenerativeModel.mock.calls[0][0] as {
      systemInstruction: string;
    };
    expect(modelOptions.systemInstruction).toContain("Engineering Manager");
    expect(modelOptions.systemInstruction).toContain("Focus on team dynamics");
  });

  it("falls back to rule-based suggestions when the SDK throws", async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error("Network error"));

    const provider = new GeminiProvider("fake-key");
    const results = await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("Why did you choose that approach?")],
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((s) => s.sessionId === sessionId)).toBe(true);
  });

  it("falls back to rule-based suggestions when the SDK returns an error response", async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    const provider = new GeminiProvider("fake-key");
    const results = await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("There is a risk with the rollout.")],
    });

    expect(results.length).toBeGreaterThan(0);
    const titles = results.map((s) => s.title);
    expect(titles).toContain("Probe the risk");
  });

  it("falls back gracefully when the SDK returns malformed text", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => "not json {{{" },
    });

    const provider = new GeminiProvider("fake-key");
    const results = await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("Some text.")],
    });

    expect(results.length).toBeGreaterThan(0);
  });
});

describe("DefaultTranscriptProvider", () => {
  const provider = new DefaultTranscriptProvider();
  const sessionId = "sess-transcript-test";

  it("normalizes a valid chunk", () => {
    const entry = provider.normalizeChunk({ sessionId, text: "  Hello world  ", speakerId: "  Alice  " });
    expect(entry.text).toBe("Hello world");
    expect(entry.speakerId).toBe("Alice");
    expect(entry.sessionId).toBe(sessionId);
    expect(entry.id).toBeTruthy();
  });

  it("defaults speakerId to 'speaker-1' when not provided", () => {
    const entry = provider.normalizeChunk({ sessionId, text: "Some text" });
    expect(entry.speakerId).toBe("speaker-1");
  });

  it("defaults speakerId to 'speaker-1' for blank speakerId", () => {
    const entry = provider.normalizeChunk({ sessionId, text: "Some text", speakerId: "   " });
    expect(entry.speakerId).toBe("speaker-1");
  });

  it("uses provided timestamp", () => {
    const ts = "2025-01-01T00:00:00.000Z";
    const entry = provider.normalizeChunk({ sessionId, text: "Some text", timestamp: ts });
    expect(entry.timestamp).toBe(ts);
  });

  it("generates a timestamp when not provided", () => {
    const entry = provider.normalizeChunk({ sessionId, text: "Some text" });
    expect(entry.timestamp).toBeTruthy();
    expect(() => new Date(entry.timestamp)).not.toThrow();
  });

  it("throws AppError for empty text", () => {
    expect(() =>
      provider.normalizeChunk({ sessionId, text: "" }),
    ).toThrow("Transcript text is required");
  });

  it("throws AppError for whitespace-only text", () => {
    expect(() =>
      provider.normalizeChunk({ sessionId, text: "   " }),
    ).toThrow("Transcript text is required");
  });
});
