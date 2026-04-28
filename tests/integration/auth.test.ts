import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp, getTestDatabaseUrl } from "@/tests/helpers/createTestApp";
import { makeRegisterPayload } from "@/tests/factories/auth.factory";

if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  console.warn("Skipping auth integration tests — set TEST_DATABASE_URL to run them");
}

const runTests = Boolean(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);

type TestAgent = Awaited<ReturnType<typeof createTestApp>>["agent"];
type AgentFactory = Awaited<ReturnType<typeof createTestApp>>["makeAgent"];

let agent: TestAgent;
let makeAgent: AgentFactory;
let pg: import("pg").Pool | undefined;

beforeAll(async () => {
  if (!runTests) return;
  const app = await createTestApp();
  agent = app.agent;
  makeAgent = app.makeAgent;
  pg = app.pg.pool;
  await pg.query("DELETE FROM auth_refresh_tokens");
  await pg.query("DELETE FROM auth_users");
});

afterAll(async () => {
  if (!runTests || !pg) return;
  await pg.query("DELETE FROM auth_refresh_tokens");
  await pg.query("DELETE FROM auth_users");
  await pg.end();
});

describe("POST /api/v1/auth/register", () => {
  it("creates a new account, returns accessToken, and sets refreshToken cookie", async () => {
    const payload = makeRegisterPayload();
    const res = await agent.post("/api/v1/auth/register").send(payload).expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email.toLowerCase()).toBe(payload.email.toLowerCase());
    expect(res.body.data.tokens.accessToken).toBeTruthy();
    expect(res.body.data.tokens.refreshToken).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("returns 422 when email is missing", async () => {
    const { email: _omit, ...rest } = makeRegisterPayload();
    const res = await agent.post("/api/v1/auth/register").send(rest).expect(422);
    expect(res.body.success).toBe(false);
  });

  it("returns 422 when password is too short", async () => {
    const payload = makeRegisterPayload({ password: "short" });
    const res = await agent.post("/api/v1/auth/register").send(payload).expect(422);
    expect(res.body.success).toBe(false);
  });

  it("returns 422 when email is invalid", async () => {
    const payload = makeRegisterPayload({ email: "not-an-email" });
    const res = await agent.post("/api/v1/auth/register").send(payload).expect(422);
    expect(res.body.success).toBe(false);
  });

  it("returns 409 on duplicate email", async () => {
    const payload = makeRegisterPayload();
    await agent.post("/api/v1/auth/register").send(payload).expect(201);
    const res = await agent.post("/api/v1/auth/register").send(payload).expect(409);
    expect(res.body.success).toBe(false);
  });
});

describe("POST /api/v1/auth/login", () => {
  it("logs in with correct credentials and sets refreshToken cookie", async () => {
    const payload = makeRegisterPayload();
    await agent.post("/api/v1/auth/register").send(payload).expect(201);

    const res = await agent
      .post("/api/v1/auth/login")
      .send({ email: payload.email, password: payload.password })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.tokens.accessToken).toBeTruthy();
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("returns 401 with wrong password", async () => {
    const payload = makeRegisterPayload();
    await agent.post("/api/v1/auth/register").send(payload).expect(201);

    const res = await agent
      .post("/api/v1/auth/login")
      .send({ email: payload.email, password: "wrong-password-999" })
      .expect(401);

    expect(res.body.success).toBe(false);
  });

  it("returns 422 when fields are missing", async () => {
    const res = await agent.post("/api/v1/auth/login").send({}).expect(422);
    expect(res.body.success).toBe(false);
  });
});

describe("POST /api/v1/auth/refresh", () => {
  it("returns a new access token using the cookie set during register", async () => {
    const freshAgent = makeAgent();
    await freshAgent.post("/api/v1/auth/register").send(makeRegisterPayload()).expect(201);

    const res = await freshAgent.post("/api/v1/auth/refresh").expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it("returns 401 when no refresh cookie is present", async () => {
    const freshAgent = makeAgent(); // no prior register → no cookie
    const res = await freshAgent.post("/api/v1/auth/refresh").expect(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 with an invalid refresh token in the cookie", async () => {
    const freshAgent = makeAgent();
    const res = await freshAgent
      .post("/api/v1/auth/refresh")
      .set("Cookie", "refreshToken=invalid.token.here")
      .expect(401);
    expect(res.body.success).toBe(false);
  });
});

describe("DELETE /api/v1/auth/logout", () => {
  it("logs out successfully using the cookie", async () => {
    const freshAgent = makeAgent();
    await freshAgent.post("/api/v1/auth/register").send(makeRegisterPayload()).expect(201);

    const res = await freshAgent.delete("/api/v1/auth/logout").expect(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 200 even when no cookie is present", async () => {
    const freshAgent = makeAgent();
    const res = await freshAgent.delete("/api/v1/auth/logout").expect(200);
    expect(res.body.success).toBe(true);
  });
});

describe("GET /api/v1/auth/me", () => {
  it("returns the full authenticated user (name and createdAt included)", async () => {
    const payload = makeRegisterPayload();
    const registerRes = await agent.post("/api/v1/auth/register").send(payload).expect(201);
    const { accessToken } = registerRes.body.data.tokens;

    const res = await agent
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.email.toLowerCase()).toBe(payload.email.toLowerCase());
    expect(res.body.data.name).toBeTruthy();
    expect(res.body.data.createdAt).toBeTruthy();
  });

  it("returns 401 without a token", async () => {
    const res = await agent.get("/api/v1/auth/me").expect(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 with an invalid token", async () => {
    const res = await agent
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer invalid.token.here")
      .expect(401);

    expect(res.body.success).toBe(false);
  });
});
