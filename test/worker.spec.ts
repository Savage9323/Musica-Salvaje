import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/worker";

const testEnv = env as unknown as Env;

async function createSong(idea: string) {
  const response = await worker.fetch(new Request("http://example.com/api/songs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idea, testOnly: true })
  }), testEnv);
  return { response, body: await response.json() as { song: { catalogId: string; status: string; audioUrls: string[] }; duplicate: boolean } };
}

describe("Música Salvaje Worker v2", () => {
  it("reports health in free test mode", async () => {
    const response = await worker.fetch(new Request("http://example.com/health"), testEnv);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; mode: string; version: string };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("test");
    expect(body.version).toBe("v2");
  });

  it("serves generated test media without external APIs", async () => {
    const audio = await worker.fetch(new Request("http://example.com/api/test/audio.wav"), testEnv);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toContain("audio/wav");
    expect((await audio.arrayBuffer()).byteLength).toBeGreaterThan(10000);

    const cover = await worker.fetch(new Request("http://example.com/api/test/cover.svg"), testEnv);
    expect(cover.status).toBe(200);
    expect(cover.headers.get("content-type")).toContain("image/svg+xml");
    expect(await cover.text()).toContain("MÚSICA SALVAJE");
  });

  it("creates a complete no-cost mock song and deduplicates retries", async () => {
    const idea = "Un hombre sale de su pueblo para trabajar y cumplir una promesa a su familia v2";
    const first = await createSong(idea);
    expect(first.response.status).toBe(201);
    expect(first.body.duplicate).toBe(false);
    expect(first.body.song.status).toBe("AUDIO_READY");
    expect(first.body.song.audioUrls).toHaveLength(2);

    const second = await createSong(idea);
    expect(second.body.duplicate).toBe(true);
  });

  it("prepares publishing metadata at zero API cost", async () => {
    const created = await createSong("Una familia levanta su negocio con años de sacrificio para una prueba de publicación");
    const id = created.body.song.catalogId;
    const response = await worker.fetch(new Request(`http://example.com/api/songs/${encodeURIComponent(id)}/publishing/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoUrl: "https://example.com/render.mp4" })
    }), testEnv);
    expect(response.status).toBe(200);
    const body = await response.json() as { publishing: { status: string; youtube_video_id: string | null; seo_json: string } };
    expect(body.publishing.status).toBe("PREPARED");
    expect(body.publishing.youtube_video_id).toBeNull();
    expect(JSON.parse(body.publishing.seo_json).title).toContain("Música Salvaje");

    const songResponse = await worker.fetch(new Request(`http://example.com/api/songs/${encodeURIComponent(id)}`), testEnv);
    const songBody = await songResponse.json() as { song: { status: string } };
    expect(songBody.song.status).toBe("READY_TO_PUBLISH");
  });

  it("refuses public publishing without explicit approval", async () => {
    const created = await createSong("Una historia distinta para verificar el bloqueo de publicación pública sin aprobación");
    const id = created.body.song.catalogId;
    await worker.fetch(new Request(`http://example.com/api/songs/${encodeURIComponent(id)}/publishing/prepare`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoUrl: "https://example.com/render2.mp4" })
    }), testEnv);
    const response = await worker.fetch(new Request(`http://example.com/api/songs/${encodeURIComponent(id)}/publish`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved: false })
    }), testEnv);
    expect(response.status).toBe(500);
    expect((await response.json() as { error: string }).error).toContain("Explicit approval");
  });

  it("keeps paid generation usage at zero in test mode", async () => {
    const response = await worker.fetch(new Request("http://example.com/api/budget"), testEnv);
    const body = await response.json() as { budget: { paidGenerationsToday: number; testMode: boolean } };
    expect(body.budget.testMode).toBe(true);
    expect(body.budget.paidGenerationsToday).toBe(0);
  });
});
