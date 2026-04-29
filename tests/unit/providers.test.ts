import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

describe("GeminiProvider", () => {
  const sessionId = "sess-gemini-test";

  function geminiRestPayload(text: string) {
    return {
      candidates: [{ content: { parts: [{ text }] } }],
    };
  }

  function mockFetchOk(suggestions: Array<{ title: string; text: string }>) {
    const text = JSON.stringify(suggestions);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(geminiRestPayload(text)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns suggestions parsed from the Gemini REST response", async () => {
    mockFetchOk([
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

  it("calls v1beta gemini-2.5-flash generateContent", async () => {
    mockFetchOk([{ title: "A", text: "Q" }]);

    const provider = new GeminiProvider("my-key");
    await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("Hi.")],
    });

    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toContain("generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(url).toContain("key=my-key");
  });

  it("caps parsed model suggestions at 3 even when the API returns more", async () => {
    mockFetchOk(Array.from({ length: 8 }, (_, i) => ({ title: `Prompt ${i}`, text: `Question ${i}` })));

    const provider = new GeminiProvider("fake-key");
    const results = await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("Some context.")],
    });

    expect(results).toHaveLength(3);
  });

  it("includes transcript ids from the recent entries", async () => {
    const entry = makeEntry("How did that go?", "entry-abc");
    mockFetchOk([{ title: "Follow up", text: "Tell me more." }]);

    const provider = new GeminiProvider("fake-key");
    const results = await provider.generateSuggestions({
      sessionId,
      recentTranscript: [entry],
    });

    expect(results[0].transcriptIds).toContain("entry-abc");
  });

  it("passes context role and notes into the user message", async () => {
    mockFetchOk([]);

    const provider = new GeminiProvider("fake-key");
    await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("Some text.")],
      context: { role: "Engineering Manager", notes: "Focus on team dynamics" },
    });

    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    const userText = body.contents[0].parts[0].text;
    expect(userText).toContain("Engineering Manager");
    expect(userText).toContain("Focus on team dynamics");
  });

  it("falls back to rule-based suggestions when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const provider = new GeminiProvider("fake-key");
    const results = await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("Why did you choose that approach?")],
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((s) => s.sessionId === sessionId)).toBe(true);
  });

  it("falls back to rule-based suggestions when the API returns non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 429, statusText: "Too Many Requests" })),
    );

    const provider = new GeminiProvider("fake-key");
    const results = await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("There is a risk with the rollout.")],
    });

    expect(results.length).toBeGreaterThan(0);
    const titles = results.map((s) => s.title);
    expect(titles).toContain("Probe the risk");
  });

  it("after a 4xx does not call fetch again until backoff expires", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 404, statusText: "Not Found" }))
      .mockResolvedValue(
        new Response(JSON.stringify(geminiRestPayload(JSON.stringify([{ title: "A", text: "B" }]))), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiProvider("fake-key");
    await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("hello")],
    });
    await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("hello again")],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses custom model id in the endpoint", async () => {
    mockFetchOk([{ title: "A", text: "Q" }]);

    const provider = new GeminiProvider("k", { modelId: "gemini-2.5-flash-preview-05-20" });
    await provider.generateSuggestions({
      sessionId,
      recentTranscript: [makeEntry("Hi.")],
    });

    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toContain("models/gemini-2.5-flash-preview-05-20:generateContent");
  });

  it("falls back gracefully when the API returns malformed JSON in the model text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(geminiRestPayload("not json {{{")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

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
