import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import gateway, { isReservationStale } from "../src/gateway";

const testEnv = env as unknown as Env;
function withEnv(values: Partial<Env>): Env {
  return Object.assign(Object.create(testEnv), values) as Env;
}

describe("live-spend gateway", () => {
  it("keeps free test generation available with zero secrets", async () => {
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

  it("fails closed on a live request while the live switch is disabled", async () => {
    const response = await gateway.fetch(new Request("http://example.com/api/songs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idea: "Una canción que nunca debe llegar a un proveedor pagado en esta prueba", testOnly: false })
    }), testEnv);
    expect(response.status).toBe(423);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("Live generation is locked");
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
