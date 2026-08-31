import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/server";

describe("Música Salvaje Worker", () => {
  it("reports health in free test mode", async () => {
    const response = await worker.fetch(new Request("http://example.com/health"), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; mode: string };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("test");
  });

  it("serves generated test media without external APIs", async () => {
    const audio = await worker.fetch(new Request("http://example.com/api/test/audio.wav"), env);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toContain("audio/wav");
    expect((await audio.arrayBuffer()).byteLength).toBeGreaterThan(10000);

    const cover = await worker.fetch(new Request("http://example.com/api/test/cover.svg"), env);
    expect(cover.status).toBe(200);
    expect(cover.headers.get("content-type")).toContain("image/svg+xml");
    expect(await cover.text()).toContain("MÚSICA SALVAJE");
  });

  it("creates a complete no-cost mock song and deduplicates retries", async () => {
    const idea = "Un hombre sale de su pueblo para trabajar y cumplir una promesa a su familia";
    const first = await worker.fetch(new Request("http://example.com/api/songs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea, testOnly: true })
    }), env);
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { song: { status: string; audioUrls: string[] }; duplicate: boolean };
    expect(firstBody.duplicate).toBe(false);
    expect(firstBody.song.status).toBe("AUDIO_READY");
    expect(firstBody.song.audioUrls).toHaveLength(2);

    const second = await worker.fetch(new Request("http://example.com/api/songs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea, testOnly: true })
    }), env);
    const secondBody = await second.json() as { duplicate: boolean };
    expect(secondBody.duplicate).toBe(true);
  });

  it("keeps paid generation usage at zero in test mode", async () => {
    const response = await worker.fetch(new Request("http://example.com/api/budget"), env);
    const body = await response.json() as { budget: { paidGenerationsToday: number; testMode: boolean } };
    expect(body.budget.testMode).toBe(true);
    expect(body.budget.paidGenerationsToday).toBe(0);
  });
});
