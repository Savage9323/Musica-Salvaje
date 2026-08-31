import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import gateway from "../src/gateway";

const testEnv = env as unknown as Env;

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
});
