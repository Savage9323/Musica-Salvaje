import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import gateway, { isReservationStale } from "../src/gateway";

const workerEnv = env as unknown as Env;
function withEnv(values: Partial<Env>): Env {
  return Object.assign(Object.create(workerEnv), values) as Env;
}
const testEnv = withEnv({ ALLOW_UNAUTHENTICATED_TEST_API: "true" });

describe("live-spend gateway", () => {
  it("keeps explicitly local free test generation available with zero secrets", async () => {
    const response = await gateway.fetch(new Request("http://example.com/api/songs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idea: "Una canción de prueba suficientemente detallada para el gateway", testOnly: true })
    }), testEnv);
    expect(response.status).toBe(201);
    const body = await response.json() as { song: { paidGeneration: boolean; status: string } };
    expect(body.song.paidGeneration).toBe(false);
    expect(body.song.status).toBe("AUDIO_READY");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("fails closed for a deployed-style test API without admin auth", async () => {
    const lockedTest = withEnv({ TEST_MODE: "true", ALLOW_UNAUTHENTICATED_TEST_API: "false", ADMIN_API_TOKEN: undefined });
    const response = await gateway.fetch(new Request("http://example.com/api/budget"), lockedTest);
    expect(response.status).toBe(401);
  });

  it("keeps synthetic test media readable without an admin header", async () => {
    const lockedTest = withEnv({ TEST_MODE: "true", ALLOW_UNAUTHENTICATED_TEST_API: "false", ADMIN_API_TOKEN: "secret" });
    const response = await gateway.fetch(new Request("http://example.com/api/test/audio.wav"), lockedTest);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/wav");
  });

  it("fails closed on a paid live request while the live switch is disabled", async () => {
    const token = "test-admin-token";
    const lockedLive = withEnv({
      TEST_MODE: "false",
      ALLOW_UNAUTHENTICATED_TEST_API: "false",
      ADMIN_API_TOKEN: token,
      MUSIC_PROVIDER: "sunoapi.org",
      LIVE_GENERATION_ENABLED: "false"
    });
    const response = await gateway.fetch(new Request("http://example.com/api/songs", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ idea: "Una canción pagada que nunca debe pasar el interruptor de gasto", testOnly: false })
    }), lockedLive);
    expect(response.status).toBe(423);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("Live generation is locked");
  });

  it("does not route a free ACE-Step request through the paid budget gate", async () => {
    const token = "ace-step-admin-token";
    const freeLive = withEnv({
      TEST_MODE: "false",
      ALLOW_UNAUTHENTICATED_TEST_API: "false",
      ADMIN_API_TOKEN: token,
      LYRICS_PROVIDER: "mock",
      MUSIC_PROVIDER: "ace-step-github",
      LIVE_GENERATION_ENABLED: "false",
      MAX_DAILY_PAID_GENERATIONS: "0",
      MAX_MONTHLY_PAID_GENERATIONS: "0"
    });
    const response = await gateway.fetch(new Request("http://example.com/api/songs", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ idea: `Prueba ACE-Step gratuita sin reserva pagada ${crypto.randomUUID()}`, testOnly: false })
    }), freeLive);
    expect(response.status).toBe(201);
    const body = await response.json() as { song: { status: string; paidGeneration: boolean; error: string | null } };
    expect(body.song.status).toBe("MUSIC_FAILED");
    expect(body.song.paidGeneration).toBe(false);
    expect(body.song.error).toContain("FREE_PROVIDER_NOT_READY");
  });

  it("recognizes abandoned budget reservations after the safety TTL", () => {
    const now = Date.parse("2026-08-31T22:00:00.000Z");
    expect(isReservationStale({ createdAt: "2026-08-31T21:29:59.000Z" }, now)).toBe(true);
    expect(isReservationStale({ createdAt: "2026-08-31T21:45:00.000Z" }, now)).toBe(false);
    expect(isReservationStale({ createdAt: "invalid" }, now)).toBe(true);
  });

  it("serializes reservations and enforces daily/monthly caps", async () => {
    const name = `budget-${crypto.randomUUID()}`;
    const stub = testEnv.BudgetGate.get(testEnv.BudgetGate.idFromName(name));
    const reserve = () => stub.fetch("https://budget.local/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxDaily: 1, maxMonthly: 1 })
    });
    const first = await reserve();
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { reservation: { id: string } };
    const blocked = await reserve();
    expect(blocked.status).toBe(429);

    const release = await stub.fetch("https://budget.local/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: firstBody.reservation.id })
    });
    expect(release.status).toBe(200);
    expect((await reserve()).status).toBe(200);
  });

  it("commits usage after a reserved live attempt", async () => {
    const name = `commit-${crypto.randomUUID()}`;
    const stub = testEnv.BudgetGate.get(testEnv.BudgetGate.idFromName(name));
    const reserved = await stub.fetch("https://budget.local/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxDaily: 2, maxMonthly: 3 })
    });
    const body = await reserved.json() as { reservation: { id: string } };
    await stub.fetch("https://budget.local/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: body.reservation.id })
    });
    const status = await stub.fetch("https://budget.local/status");
    const ledger = await status.json() as { dailyUsed: number; dailyReserved: number; monthlyUsed: number; monthlyReserved: number };
    expect(ledger.dailyUsed).toBe(1);
    expect(ledger.monthlyUsed).toBe(1);
    expect(ledger.dailyReserved).toBe(0);
    expect(ledger.monthlyReserved).toBe(0);
  });

  it("keeps production catalog reads private", async () => {
    const prod = withEnv({ TEST_MODE: "false", ADMIN_API_TOKEN: "correct-horse-battery-staple" });
    const unauthorized = await gateway.fetch(new Request("http://example.com/api/songs"), prod);
    expect(unauthorized.status).toBe(401);
    const body = await unauthorized.json() as { error: string };
    expect(body.error).toContain("Admin authorization");
  });

  it("accepts the admin bearer token for production status reads", async () => {
    const token = "correct-horse-battery-staple";
    const prod = withEnv({ TEST_MODE: "false", ADMIN_API_TOKEN: token });
    const response = await gateway.fetch(new Request("http://example.com/api/budget", {
      headers: { Authorization: `Bearer ${token}` }
    }), prod);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; budget: { testMode: boolean } };
    expect(body.ok).toBe(true);
    expect(body.budget.testMode).toBe(false);
  });

  it("disables the direct Agents transport in production", async () => {
    const prod = withEnv({ TEST_MODE: "false", ADMIN_API_TOKEN: "secret" });
    const response = await gateway.fetch(new Request("http://example.com/agents/MusicaSalvajeAgent/studio"), prod);
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("disabled in production");
  });
});
