import { Agent, getAgentByName, routeAgentRequest } from "agents";
import { generateLyrics, generateMusic, passesQuality, sha256 } from "./providers";
import type { SongRecord, SongRequest, SongStatus } from "./types";

interface SongRow {
  catalog_id: string;
  created_at: string;
  updated_at: string;
  request_hash: string;
  idea: string;
  title: string | null;
  lyrics: string | null;
  style_prompt: string | null;
  quality_score: number | null;
  status: SongStatus;
  lyrics_provider: string | null;
  music_provider: string | null;
  provider_task_id: string | null;
  audio_urls_json: string;
  cover_url: string | null;
  paid_generation: number;
  error: string | null;
}

function toRecord(row: SongRow): SongRecord {
  return {
    catalogId: row.catalog_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    requestHash: row.request_hash,
    idea: row.idea,
    title: row.title,
    lyrics: row.lyrics,
    stylePrompt: row.style_prompt,
    qualityScore: row.quality_score,
    status: row.status,
    lyricsProvider: row.lyrics_provider,
    musicProvider: row.music_provider,
    providerTaskId: row.provider_task_id,
    audioUrls: JSON.parse(row.audio_urls_json || "[]") as string[],
    coverUrl: row.cover_url,
    paidGeneration: row.paid_generation === 1,
    error: row.error
  };
}

function catalogId(): string {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replaceAll("-", "");
  const random = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
  return `MS-${ymd}-${String(random).padStart(4, "0")}`;
}

export class MusicaSalvajeAgent extends Agent<Env> {
  onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS songs (
        catalog_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        idea TEXT NOT NULL,
        title TEXT,
        lyrics TEXT,
        style_prompt TEXT,
        quality_score REAL,
        status TEXT NOT NULL,
        lyrics_provider TEXT,
        music_provider TEXT,
        provider_task_id TEXT,
        audio_urls_json TEXT NOT NULL DEFAULT '[]',
        cover_url TEXT,
        paid_generation INTEGER NOT NULL DEFAULT 0,
        error TEXT
      )
    `;
    this.sql`CREATE INDEX IF NOT EXISTS idx_songs_hash ON songs(request_hash)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_songs_task ON songs(provider_task_id)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_songs_created ON songs(created_at)`;
  }

  async createSong(request: SongRequest): Promise<{ duplicate: boolean; song: SongRecord }> {
    const idea = String(request.idea ?? "").trim();
    if (idea.length < 12) throw new Error("Song idea must be at least 12 characters");
    if (idea.length > 4000) throw new Error("Song idea must be 4000 characters or fewer");

    const requestHash = await sha256(JSON.stringify({
      idea,
      instrumental: request.instrumental ?? false,
      language: request.language ?? "es",
      genre: request.genre ?? "regional Mexican",
      mood: request.mood ?? []
    }));
    const existing = this.sql<SongRow>`SELECT * FROM songs WHERE request_hash = ${requestHash} AND status NOT IN ('MUSIC_FAILED', 'QUALITY_REJECTED') ORDER BY created_at DESC LIMIT 1`;
    if (existing[0]) return { duplicate: true, song: toRecord(existing[0]) };

    const id = catalogId();
    const now = new Date().toISOString();
    this.sql`INSERT INTO songs (catalog_id, created_at, updated_at, request_hash, idea, status) VALUES (${id}, ${now}, ${now}, ${requestHash}, ${idea}, 'REQUESTED')`;

    try {
      this.updateStatus(id, "LYRICS_GENERATING");
      const lyricsResult = await generateLyrics(this.env, { ...request, idea });
      this.updateStatus(id, "LYRICS_QA");
      const gate = Math.max(0, Math.min(10, Number(this.env.QUALITY_GATE ?? "8")));
      if (!passesQuality(lyricsResult.package, gate)) {
        this.sql`UPDATE songs SET status = 'QUALITY_REJECTED', updated_at = ${new Date().toISOString()}, title = ${lyricsResult.package.title}, lyrics = ${lyricsResult.package.lyrics}, style_prompt = ${lyricsResult.package.stylePrompt}, quality_score = ${lyricsResult.package.overallScore}, lyrics_provider = ${lyricsResult.provider}, error = ${`Quality score ${lyricsResult.package.overallScore} did not meet gate ${gate}`} WHERE catalog_id = ${id}`;
        return { duplicate: false, song: this.getSongOrThrow(id) };
      }

      this.sql`UPDATE songs SET status = 'READY_FOR_MUSIC', updated_at = ${new Date().toISOString()}, title = ${lyricsResult.package.title}, lyrics = ${lyricsResult.package.lyrics}, style_prompt = ${lyricsResult.package.stylePrompt}, quality_score = ${lyricsResult.package.overallScore}, lyrics_provider = ${lyricsResult.provider} WHERE catalog_id = ${id}`;

      const testMode = this.env.TEST_MODE !== "false" || request.testOnly === true;
      if (!testMode) {
        const paidToday = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM songs WHERE paid_generation = 1 AND created_at >= ${new Date().toISOString().slice(0, 10) + "T00:00:00.000Z"}`[0]?.count ?? 0;
        const maxDaily = Math.max(0, Number(this.env.MAX_DAILY_PAID_GENERATIONS ?? "2"));
        if (paidToday >= maxDaily) {
          this.sql`UPDATE songs SET status = 'BUDGET_BLOCKED', updated_at = ${new Date().toISOString()}, error = ${`Daily paid generation cap reached (${maxDaily})`} WHERE catalog_id = ${id}`;
          return { duplicate: false, song: this.getSongOrThrow(id) };
        }
      }

      this.updateStatus(id, "MUSIC_GENERATING");
      const music = await generateMusic(this.env, { ...request, idea }, lyricsResult.package);
      const paid = music.provider === "sunoapi.org" ? 1 : 0;
      const audioUrls = music.tracks.map((t) => t.audioUrl);
      const coverUrl = music.tracks.find((t) => t.imageUrl)?.imageUrl ?? null;
      const status: SongStatus = music.tracks.length ? "AUDIO_READY" : "MUSIC_GENERATING";
      this.sql`UPDATE songs SET status = ${status}, updated_at = ${new Date().toISOString()}, music_provider = ${music.provider}, provider_task_id = ${music.taskId}, audio_urls_json = ${JSON.stringify(audioUrls)}, cover_url = ${coverUrl}, paid_generation = ${paid} WHERE catalog_id = ${id}`;
      return { duplicate: false, song: this.getSongOrThrow(id) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const budget = message.startsWith("BUDGET_BLOCKED:");
      this.sql`UPDATE songs SET status = ${budget ? "BUDGET_BLOCKED" : "MUSIC_FAILED"}, updated_at = ${new Date().toISOString()}, error = ${message} WHERE catalog_id = ${id}`;
      return { duplicate: false, song: this.getSongOrThrow(id) };
    }
  }

  getSong(id: string): SongRecord | null {
    const [row] = this.sql<SongRow>`SELECT * FROM songs WHERE catalog_id = ${id} LIMIT 1`;
    return row ? toRecord(row) : null;
  }

  listSongs(limit = 20): SongRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.sql<SongRow>`SELECT * FROM songs ORDER BY created_at DESC LIMIT ${safeLimit}`.map(toRecord);
  }

  getBudgetStatus() {
    const today = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
    const paidToday = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM songs WHERE paid_generation = 1 AND created_at >= ${today}`[0]?.count ?? 0;
    const maxDaily = Math.max(0, Number(this.env.MAX_DAILY_PAID_GENERATIONS ?? "2"));
    return {
      testMode: this.env.TEST_MODE !== "false",
      lyricsProvider: this.env.LYRICS_PROVIDER ?? "mock",
      paidGenerationsToday: paidToday,
      maxDailyPaidGenerations: maxDaily,
      paidGenerationRemaining: Math.max(0, maxDaily - paidToday)
    };
  }

  handleSunoCallback(payload: unknown): SongRecord | null {
    const body = payload as {
      code?: number;
      msg?: string;
      data?: {
        callbackType?: string;
        task_id?: string;
        data?: Array<{ audio_url?: string; image_url?: string }>;
      };
    };
    const taskId = body.data?.task_id;
    if (!taskId) return null;
    const tracks = body.data?.data ?? [];
    if (body.code !== 200) {
      this.sql`UPDATE songs SET status = 'MUSIC_FAILED', updated_at = ${new Date().toISOString()}, error = ${body.msg ?? "Suno callback failure"} WHERE provider_task_id = ${taskId}`;
    } else if (body.data?.callbackType === "complete") {
      const audioUrls = tracks.flatMap((t) => (t.audio_url ? [t.audio_url] : []));
      const cover = tracks.find((t) => t.image_url)?.image_url ?? null;
      this.sql`UPDATE songs SET status = 'AUDIO_READY', updated_at = ${new Date().toISOString()}, audio_urls_json = ${JSON.stringify(audioUrls)}, cover_url = ${cover}, error = NULL WHERE provider_task_id = ${taskId}`;
    }
    const [row] = this.sql<SongRow>`SELECT * FROM songs WHERE provider_task_id = ${taskId} LIMIT 1`;
    return row ? toRecord(row) : null;
  }

  private getSongOrThrow(id: string): SongRecord {
    const song = this.getSong(id);
    if (!song) throw new Error(`Song ${id} not found after write`);
    return song;
  }

  private updateStatus(id: string, status: SongStatus) {
    this.sql`UPDATE songs SET status = ${status}, updated_at = ${new Date().toISOString()} WHERE catalog_id = ${id}`;
  }
}

function jsonError(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status });
}

function makeTestWav(seconds = 1.5, sampleRate = 8000, frequency = 440): ArrayBuffer {
  const samples = Math.floor(seconds * sampleRate);
  const dataBytes = samples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples; i++) {
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.18;
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }
  return buffer;
}

function testCoverSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#111"/><text x="512" y="475" text-anchor="middle" fill="white" font-family="sans-serif" font-size="64" font-weight="700">MÚSICA SALVAJE</text><text x="512" y="555" text-anchor="middle" fill="#bbb" font-family="sans-serif" font-size="34">FREE TEST MODE</text></svg>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "musica-salvaje-agent", mode: env.TEST_MODE !== "false" ? "test" : "live" });
    }

    if (env.TEST_MODE !== "false" && url.pathname === "/api/test/audio.wav" && request.method === "GET") {
      return new Response(makeTestWav(), { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
    }
    if (env.TEST_MODE !== "false" && url.pathname === "/api/test/cover.svg" && request.method === "GET") {
      return new Response(testCoverSvg(), { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" } });
    }

    if (url.pathname.startsWith("/api/")) {
      const studio = await getAgentByName(env.MusicaSalvajeAgent, "studio", { routingRetry: { maxAttempts: 3 } });
      try {
        if (url.pathname === "/api/songs" && request.method === "POST") {
          const body = (await request.json()) as SongRequest;
          const result = await studio.createSong(body);
          return Response.json({ ok: true, ...result }, { status: result.duplicate ? 200 : 201 });
        }
        if (url.pathname === "/api/songs" && request.method === "GET") {
          return Response.json({ ok: true, songs: await studio.listSongs(Number(url.searchParams.get("limit") ?? "20")) });
        }
        if (url.pathname.startsWith("/api/songs/") && request.method === "GET") {
          const id = decodeURIComponent(url.pathname.slice("/api/songs/".length));
          const song = await studio.getSong(id);
          return song ? Response.json({ ok: true, song }) : jsonError("Song not found", 404);
        }
        if (url.pathname === "/api/budget" && request.method === "GET") {
          return Response.json({ ok: true, budget: await studio.getBudgetStatus() });
        }
        if (url.pathname === "/api/callbacks/suno" && request.method === "POST") {
          const song = await studio.handleSunoCallback(await request.json());
          return Response.json({ ok: true, song });
        }
        return jsonError("API route not found", 404);
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : String(error), 500);
      }
    }

    const agentResponse = await routeAgentRequest(request, env, { cors: true });
    if (agentResponse) return agentResponse;
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
