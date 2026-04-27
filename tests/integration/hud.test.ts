import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp, makeAuthHeader } from "@/tests/helpers/createTestApp";
import { makeSessionId, makeTranscriptChunk, makeTag, makeContext } from "@/tests/factories/hud.factory";

if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn("Skipping HUD integration tests — set TEST_DATABASE_URL to run them");
}

const runTests = Boolean(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);

type TestAgent = Awaited<ReturnType<typeof createTestApp>>["agent"];

let agent: TestAgent;
let pg: import("pg").Pool | undefined;
// S-17: shared auth header — all HUD routes require authentication
let authHeader: string;

beforeAll(async () => {
  if (!runTests) return;
  const app = await createTestApp();
  agent = app.agent;
  pg = app.pg.pool;
  authHeader = makeAuthHeader();
});

afterAll(async () => {
  if (!runTests || !pg) return;
  await pg.query("DELETE FROM hud_events");
  await pg.query("DELETE FROM hud_tags");
  await pg.query("DELETE FROM hud_prompt_suggestions");
  await pg.query("DELETE FROM hud_transcript_entries");
  await pg.query("DELETE FROM hud_sessions");
  await pg.end();
});

describe("POST /api/v1/hud/sessions/:sessionId/transcript", () => {
  it("processes a transcript chunk and returns 201", async () => {
    const sessionId = makeSessionId();
    const chunk = makeTranscriptChunk();

    const res = await agent
      .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
      .set("Authorization", authHeader)
      .send(chunk)
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.entry.text).toBe(chunk.text);
    expect(res.body.data.entry.sessionId).toBe(sessionId);
  });

  it("returns 401 without an auth token", async () => {
    const sessionId = makeSessionId();
    await agent
      .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
      .send(makeTranscriptChunk())
      .expect(401);
  });

  it("returns 422 when text is missing", async () => {
    const sessionId = makeSessionId();
    const { text: _omit, ...rest } = makeTranscriptChunk();

    const res = await agent
      .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
      .set("Authorization", authHeader)
      .send(rest)
      .expect(422);

    expect(res.body.success).toBe(false);
  });

  it("returns 422 when text is empty", async () => {
    const sessionId = makeSessionId();

    const res = await agent
      .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
      .set("Authorization", authHeader)
      .send(makeTranscriptChunk({ text: "" }))
      .expect(422);

    expect(res.body.success).toBe(false);
  });

  it("returns 422 when text exceeds 10 000 characters", async () => {
    const sessionId = makeSessionId();

    const res = await agent
      .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
      .set("Authorization", authHeader)
      .send(makeTranscriptChunk({ text: "a".repeat(10_001) }))
      .expect(422);

    expect(res.body.success).toBe(false);
  });

  it("returns AI prompts alongside the entry", async () => {
    const sessionId = makeSessionId();

    const res = await agent
      .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
      .set("Authorization", authHeader)
      .send(makeTranscriptChunk({ text: "Why did you choose that architecture?" }))
      .expect(201);

    expect(Array.isArray(res.body.data.prompts)).toBe(true);
  });
});

describe("GET /api/v1/hud/sessions/:sessionId", () => {
  it("returns the session snapshot after adding data", async () => {
    const sessionId = makeSessionId();
    await agent
      .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
      .set("Authorization", authHeader)
      .send(makeTranscriptChunk())
      .expect(201);

    const res = await agent
      .get(`/api/v1/hud/sessions/${sessionId}`)
      .set("Authorization", authHeader)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.session.id).toBe(sessionId);
    expect(res.body.data.transcriptEntries.length).toBeGreaterThan(0);
  });

  it("returns an empty session for an unknown sessionId", async () => {
    const sessionId = makeSessionId();
    const res = await agent
      .get(`/api/v1/hud/sessions/${sessionId}`)
      .set("Authorization", authHeader)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.transcriptEntries).toEqual([]);
  });

  it("returns 401 without an auth token", async () => {
    await agent.get(`/api/v1/hud/sessions/${makeSessionId()}`).expect(401);
  });
});

describe("POST /api/v1/hud/sessions/:sessionId/tags", () => {
  it("creates a tag and returns 201", async () => {
    const sessionId = makeSessionId();
    const tag = makeTag();

    const res = await agent
      .post(`/api/v1/hud/sessions/${sessionId}/tags`)
      .set("Authorization", authHeader)
      .send(tag)
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.label).toBe(tag.label);
    expect(res.body.data.sessionId).toBe(sessionId);
  });

  it("returns 422 when label is missing", async () => {
    const sessionId = makeSessionId();

    const res = await agent
      .post(`/api/v1/hud/sessions/${sessionId}/tags`)
      .set("Authorization", authHeader)
      .send({})
      .expect(422);

    expect(res.body.success).toBe(false);
  });

  it("returns 422 when label is empty", async () => {
    const sessionId = makeSessionId();

    const res = await agent
      .post(`/api/v1/hud/sessions/${sessionId}/tags`)
      .set("Authorization", authHeader)
      .send({ label: "" })
      .expect(422);

    expect(res.body.success).toBe(false);
  });

  it("returns 422 when transcriptId is not a UUID", async () => {
    const sessionId = makeSessionId();

    const res = await agent
      .post(`/api/v1/hud/sessions/${sessionId}/tags`)
      .set("Authorization", authHeader)
      .send({ label: "valid label", transcriptId: "not-a-uuid" })
      .expect(422);

    expect(res.body.success).toBe(false);
  });
});

describe("PATCH /api/v1/hud/sessions/:sessionId/context", () => {
  it("updates context and reflects changes in the returned snapshot", async () => {
    const sessionId = makeSessionId();
    const body = makeContext();

    const res = await agent
      .patch(`/api/v1/hud/sessions/${sessionId}/context`)
      .set("Authorization", authHeader)
      .send(body)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.session.context).toMatchObject(body.context);
  });

  it("returns 422 when context field is missing", async () => {
    const sessionId = makeSessionId();

    const res = await agent
      .patch(`/api/v1/hud/sessions/${sessionId}/context`)
      .set("Authorization", authHeader)
      .send({})
      .expect(422);

    expect(res.body.success).toBe(false);
  });
});

describe("GET /api/v1/hud/sessions/:sessionId/export", () => {
  async function seedSession(sessionId: string) {
    await agent
      .post(`/api/v1/hud/sessions/${sessionId}/transcript`)
      .set("Authorization", authHeader)
      .send(makeTranscriptChunk())
      .expect(201);
    await agent
      .post(`/api/v1/hud/sessions/${sessionId}/tags`)
      .set("Authorization", authHeader)
      .send(makeTag())
      .expect(201);
  }

  it("exports session as JSON with correct content-type", async () => {
    const sessionId = makeSessionId();
    await seedSession(sessionId);

    const res = await agent
      .get(`/api/v1/hud/sessions/${sessionId}/export?format=json`)
      .set("Authorization", authHeader)
      .expect(200);

    expect(res.headers["content-type"]).toMatch(/application\/json/);
    const body = JSON.parse(res.text);
    expect(body.session.id).toBe(sessionId);
    expect(body.transcriptEntries.length).toBeGreaterThan(0);
  });

  it("exports session as CSV with correct content-type", async () => {
    const sessionId = makeSessionId();
    await seedSession(sessionId);

    const res = await agent
      .get(`/api/v1/hud/sessions/${sessionId}/export?format=csv`)
      .set("Authorization", authHeader)
      .expect(200);

    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("sessionId");
    expect(res.text).toContain(sessionId);
  });
});
