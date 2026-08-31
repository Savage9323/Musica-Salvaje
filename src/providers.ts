import type { LyricsPackage, MusicResult, MusicTaskStatus, MusicTrack, QualityScores, SongRequest } from "./types";

const ARTIST_NAMES = ["grupo firme", "lalo mora", "chalino sánchez", "chalino sanchez", "banda ms", "christian nodal", "bad bunny", "peso pluma"];
const QUALITY_FIELDS = ["originality", "storytelling", "natural_spanish", "emotional_impact", "singability", "chorus_strength", "rhyme_quality", "regional_authenticity", "style_match", "commercial_potential"] as const;
const LYRIC_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "musica_salvaje_finished_song",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        lyrics: { type: "string" },
        stylePrompt: { type: "string" },
        negativeStyles: { type: "array", items: { type: "string" } },
        qualityScores: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(QUALITY_FIELDS.map((key) => [key, { type: "number", minimum: 0, maximum: 10 }])),
          required: [...QUALITY_FIELDS]
        },
        overallScore: { type: "number", minimum: 0, maximum: 10 },
        revisionCount: { type: "integer", minimum: 0, maximum: 4 }
      },
      required: ["title", "lyrics", "stylePrompt", "negativeStyles", "qualityScores", "overallScore", "revisionCount"]
    }
  }
} as const;

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function clampScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, Math.round(n * 10) / 10));
}

function cleanArtistNames(value: string): string {
  let output = value;
  for (const name of ARTIST_NAMES) output = output.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "regional Mexican");
  return output;
}

function normalizeScores(raw: Record<string, unknown>): QualityScores {
  return {
    originality: clampScore(raw.originality), storytelling: clampScore(raw.storytelling), natural_spanish: clampScore(raw.natural_spanish),
    emotional_impact: clampScore(raw.emotional_impact), singability: clampScore(raw.singability), chorus_strength: clampScore(raw.chorus_strength),
    rhyme_quality: clampScore(raw.rhyme_quality), regional_authenticity: clampScore(raw.regional_authenticity), style_match: clampScore(raw.style_match),
    commercial_potential: clampScore(raw.commercial_potential)
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = stripped.indexOf("{"); const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Lyrics provider did not return JSON");
  return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
}

export function mockLyrics(request: SongRequest): LyricsPackage {
  const subject = request.idea.replace(/\s+/g, " ").trim().slice(0, 120);
  const lyrics = `[Intro]\nBajo la luna comienza el camino,\ncon polvo en las botas y firme el destino.\n\n[Verse 1]\n${subject}\nNo fue por capricho ni por aparentar,\nfue por los de casa, por verlos avanzar.\nCon miedo en el pecho siguió sin parar,\nporque hay juramentos que pesan de verdad.\n\n[Pre-Chorus]\nCada cicatriz le enseñó la dirección,\ncuando falta el mapa sobra el corazón.\n\n[Chorus]\nVoy caminando aunque apriete la vida,\npor los que me esperan mantengo la mira.\nSi cae la noche se enciende el valor,\nno cargo coronas, cargo mi palabra y honor.\n\n[Verse 2]\nHubo puertas cerradas y días sin dormir,\npero una promesa no lo dejó desistir.\nAprendió que perder también hace crecer,\ny que el hombre se mide por volver a creer.\n\n[Bridge]\nQue suene el acordeón, que conteste el bajo,\npor todo lo ganado a fuerza de trabajo.\n\n[Final Chorus]\nVoy caminando aunque apriete la vida,\npor los que me esperan mantengo la mira.\nSi cae la noche se enciende el valor,\nno cargo coronas, cargo mi palabra y honor.\n\n[Outro]\nY mientras haya camino, todavía hay canción.`;
  const qualityScores: QualityScores = { originality: 9, storytelling: 9, natural_spanish: 9, emotional_impact: 9, singability: 9, chorus_strength: 9, rhyme_quality: 8.5, regional_authenticity: 9, style_match: 9, commercial_potential: 8.5 };
  return { title: "Camino y Palabra", lyrics, stylePrompt: "Regional Mexican corrido, 94 BPM, emotional male vocal, accordion, bajo sexto, bass and restrained percussion; intimate verses, rising pre-chorus, memorable anthemic chorus, organic dynamics.", negativeStyles: ["EDM", "trap hi-hats", "synthetic pop vocal", "comedy"], qualityScores, overallScore: 9, revisionCount: 0 };
}

function lyricSystemPrompt(): string {
  return `You are the songwriting and quality-control engine for Música Salvaje. Create FINISHED original lyrics, not a draft. Do not imitate or name real recording artists. If the request references an artist, convert that reference into generic musical characteristics and omit the artist name. Use natural Spanish unless English is explicitly requested. Use section labels [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Final Chorus], [Outro]. Score the song strictly; do not inflate scores. Aim for overallScore >= 8 and every quality dimension >= 7. stylePrompt must describe genre, subgenre, BPM, mood, energy, instruments, vocal type and dynamics without artist names.`;
}

async function callOpenAICompatible(baseUrl: string, apiKey: string, model: string, request: SongRequest, previous?: LyricsPackage, revisionNumber = 0): Promise<LyricsPackage> {
  const userPayload = previous ? {
    task: "Revise the previous finished song. Fix every weak quality dimension, improve specificity and hook strength, preserve the core story, and return a complete replacement song. Do not explain your changes.",
    revisionNumber,
    request: { idea: request.idea, language: request.language ?? "es", genre: request.genre ?? "regional Mexican", mood: request.mood ?? [], instrumental: request.instrumental ?? false, targetDurationSeconds: 165 },
    previous
  } : {
    task: "Write the finished song and score it strictly before returning it.",
    request: { idea: request.idea, language: request.language ?? "es", genre: request.genre ?? "regional Mexican", mood: request.mood ?? [], instrumental: request.instrumental ?? false, targetDurationSeconds: 165 }
  };
  const isXai = baseUrl.includes("api.x.ai");
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  if (isXai) headers["x-grok-conv-id"] = (await sha256(`${request.idea}|${request.language ?? "es"}|${request.genre ?? "regional Mexican"}`)).slice(0, 32);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.85,
      reasoning_effort: "low",
      ...(isXai ? { max_tokens: 4096 } : { max_completion_tokens: 4096 }),
      response_format: LYRIC_RESPONSE_FORMAT,
      messages: [{ role: "system", content: lyricSystemPrompt() }, { role: "user", content: JSON.stringify(userPayload) }]
    })
  });
  if (!response.ok) throw new Error(`Lyrics provider HTTP ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content; if (!content) throw new Error("Lyrics provider returned no content");
  const raw = parseJsonObject(content); const qualityScores = normalizeScores((raw.qualityScores ?? {}) as Record<string, unknown>);
  return { title: cleanArtistNames(String(raw.title ?? "Untitled")).slice(0, 100), lyrics: cleanArtistNames(String(raw.lyrics ?? "")), stylePrompt: cleanArtistNames(String(raw.stylePrompt ?? "")).slice(0, 1000), negativeStyles: Array.isArray(raw.negativeStyles) ? raw.negativeStyles.map(String).slice(0, 12) : [], qualityScores, overallScore: clampScore(raw.overallScore), revisionCount: revisionNumber };
}

export function passesQuality(pkg: LyricsPackage, gate: number): boolean {
  return pkg.overallScore >= gate && Object.values(pkg.qualityScores).every((score) => score >= 7);
}

export async function generateLyrics(env: Env, request: SongRequest): Promise<{ provider: string; package: LyricsPackage }> {
  const provider = env.LYRICS_PROVIDER ?? "mock"; if (provider === "mock") return { provider: "mock", package: mockLyrics(request) };
  let baseUrl: string; let apiKey: string | undefined; let model: string;
  if (provider === "groq") { baseUrl = "https://api.groq.com/openai/v1"; apiKey = env.GROQ_API_KEY; model = env.GROQ_MODEL ?? "openai/gpt-oss-120b"; }
  else if (provider === "xai") { baseUrl = "https://api.x.ai/v1"; apiKey = env.XAI_API_KEY; model = env.XAI_MODEL ?? "grok-4.3"; }
  else throw new Error(`Unsupported lyrics provider: ${provider}`);
  if (!apiKey) throw new Error(`${provider === "xai" ? "XAI_API_KEY" : "GROQ_API_KEY"} is required when LYRICS_PROVIDER=${provider}`);
  const gate = Math.max(0, Math.min(10, Number(env.QUALITY_GATE ?? "8"))); const maxRevisions = Math.max(0, Math.min(4, Math.trunc(Number(env.MAX_LYRIC_REVISIONS ?? "2"))));
  let current = await callOpenAICompatible(baseUrl, apiKey, model, request, undefined, 0);
  for (let revision = 1; revision <= maxRevisions && !passesQuality(current, gate); revision++) current = await callOpenAICompatible(baseUrl, apiKey, model, request, current, revision);
  return { provider, package: current };
}

export async function getSunoCredits(env: Env): Promise<number> {
  if (!env.SUNO_API_KEY) throw new Error("SUNO_API_KEY is not configured");
  const response = await fetch(`${env.SUNO_BASE_URL ?? "https://api.sunoapi.org/api/v1"}/generate/credit`, { headers: { Authorization: `Bearer ${env.SUNO_API_KEY}` } });
  if (!response.ok) throw new Error(`Suno credit check HTTP ${response.status}`);
  const body = (await response.json()) as { code?: number; msg?: string; data?: number };
  if (body.code !== 200 || typeof body.data !== "number") throw new Error(body.msg ?? "Invalid Suno credit response"); return body.data;
}

function normalizeSunoTracks(raw: Array<Record<string, unknown>>): MusicTrack[] {
  return raw.flatMap((track, index) => { const audioUrl = String(track.audio_url ?? track.audioUrl ?? ""); if (!audioUrl) return []; return [{ id: String(track.id ?? `track-${index + 1}`), audioUrl, imageUrl: String(track.image_url ?? track.imageUrl ?? "") || undefined, durationSeconds: Number(track.duration ?? 0) || undefined, title: String(track.title ?? `Track ${index + 1}`) }]; });
}

export async function getSunoTaskStatus(env: Env, taskId: string): Promise<MusicTaskStatus> {
  if (!env.SUNO_API_KEY) throw new Error("SUNO_API_KEY is not configured");
  const endpoint = new URL(`${env.SUNO_BASE_URL ?? "https://api.sunoapi.org/api/v1"}/generate/record-info`); endpoint.searchParams.set("taskId", taskId);
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${env.SUNO_API_KEY}` } });
  const body = (await response.json()) as { code?: number; msg?: string; data?: { status?: string; errorMessage?: string | null; response?: { sunoData?: Array<Record<string, unknown>> } } };
  if (!response.ok || body.code !== 200) throw new Error(`Suno status check failed: ${body.msg ?? `HTTP ${response.status}`}`);
  const providerStatus = String(body.data?.status ?? "PENDING"); if (providerStatus === "SUCCESS") return { status: "SUCCESS", providerStatus, tracks: normalizeSunoTracks(body.data?.response?.sunoData ?? []) };
  if (["CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "CALLBACK_EXCEPTION", "SENSITIVE_WORD_ERROR"].includes(providerStatus)) return { status: "FAILED", providerStatus, tracks: [], error: body.data?.errorMessage ?? providerStatus };
  return { status: "PENDING", providerStatus, tracks: normalizeSunoTracks(body.data?.response?.sunoData ?? []) };
}

export async function generateMusic(env: Env, request: SongRequest, pkg: LyricsPackage): Promise<MusicResult> {
  const base = (env.PUBLIC_BASE_URL ?? "http://localhost:8787").replace(/\/$/, ""); const testMode = env.TEST_MODE !== "false" || request.testOnly === true;
  if (testMode) return { provider: "mock", taskId: `mock-${Date.now()}`, tracks: [{ id: "mock-a", audioUrl: `${base}/api/test/audio.wav`, imageUrl: `${base}/api/test/cover.svg`, durationSeconds: 2, title: pkg.title }, { id: "mock-b", audioUrl: `${base}/api/test/audio.wav`, imageUrl: `${base}/api/test/cover.svg`, durationSeconds: 2, title: `${pkg.title} (B)` }] };
  if (!env.SUNO_API_KEY) throw new Error("SUNO_API_KEY is required for paid music generation"); if (!env.SUNO_CALLBACK_SECRET) throw new Error("SUNO_CALLBACK_SECRET is required for live music generation");
  if (!env.PUBLIC_BASE_URL?.startsWith("https://")) throw new Error("PUBLIC_BASE_URL must be an HTTPS deployment before live Suno generation so callbacks can be received");
  const creditsBefore = await getSunoCredits(env); const minimum = Math.max(1, Number(env.MIN_SUNO_CREDITS ?? "1")); if (creditsBefore < minimum) throw new Error(`BUDGET_BLOCKED: Suno balance ${creditsBefore} is below minimum ${minimum}`);
  const callbackUrl = new URL(`${base}/api/callbacks/suno`); callbackUrl.searchParams.set("token", env.SUNO_CALLBACK_SECRET);
  const response = await fetch(`${env.SUNO_BASE_URL ?? "https://api.sunoapi.org/api/v1"}/generate`, { method: "POST", headers: { Authorization: `Bearer ${env.SUNO_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ customMode: true, instrumental: request.instrumental ?? false, model: env.SUNO_MODEL ?? "V5", callBackUrl: callbackUrl.toString(), prompt: request.instrumental ? undefined : pkg.lyrics.slice(0, 5000), style: pkg.stylePrompt.slice(0, 1000), title: pkg.title.slice(0, 100), negativeTags: pkg.negativeStyles.join(", ").slice(0, 1000) }) });
  const body = (await response.json()) as { code?: number; msg?: string; data?: { taskId?: string } }; if (!response.ok || body.code !== 200 || !body.data?.taskId) throw new Error(`Suno generation failed: ${body.msg ?? `HTTP ${response.status}`}`);
  return { provider: "sunoapi.org", taskId: body.data.taskId, tracks: [], creditsBefore };
}
