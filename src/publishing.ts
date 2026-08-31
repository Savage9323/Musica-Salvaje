import type { SongRecord } from "./types";

export interface SeoMetadata {
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  categoryId: string;
  defaultLanguage: string;
}

export interface YouTubeEnv {
  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  YOUTUBE_REFRESH_TOKEN?: string;
  YOUTUBE_CONTAINS_SYNTHETIC_MEDIA?: string;
  GITHUB_TOKEN?: string;
}

export interface YouTubeUploadResult {
  videoId: string;
  url: string;
  privacyStatus: "private" | "public" | "unlisted";
}

function unique(values: string[], max: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, max);
}

function cleanTag(value: string): string {
  return value.replace(/^#+/, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim();
}

export function buildSeoMetadata(song: SongRecord, genre = "Regional Mexican"): SeoMetadata {
  const title = `${song.title ?? "Nueva Canción"} — ${genre} | Música Salvaje`.slice(0, 100);
  const idea = song.idea.replace(/\s+/g, " ").trim();
  const lyrics = (song.lyrics ?? "").trim();
  const hashtags = unique(["MusicaSalvaje", "MusicaMexicana", cleanTag(genre).replace(/\s+/g, ""), "NuevaMusica", "Corrido"], 8)
    .map((tag) => `#${tag}`);
  const description = [
    idea,
    "",
    `🎵 ${song.title ?? "Música Salvaje"}`,
    `Género: ${genre}`,
    "Producción musical de Música Salvaje.",
    "",
    lyrics ? `LETRA\n${lyrics}` : "",
    "",
    "Esta producción utiliza herramientas de inteligencia artificial dentro del proceso creativo y de producción.",
    "",
    hashtags.join(" ")
  ].filter((line, index, all) => line || (index > 0 && all[index - 1] !== "")).join("\n").slice(0, 5000);
  const tags = unique([
    song.title ?? "Música Salvaje",
    "Música Salvaje",
    genre,
    "música mexicana",
    "regional mexicano",
    "corrido",
    "nueva música",
    "canción original",
    "música en español",
    ...idea.toLowerCase().split(/\s+/).filter((word) => word.length >= 5).slice(0, 8)
  ].map(cleanTag), 20);
  return { title, description, tags, hashtags, categoryId: "10", defaultLanguage: "es" };
}

async function getAccessToken(env: YouTubeEnv): Promise<string> {
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET || !env.YOUTUBE_REFRESH_TOKEN) {
    throw new Error("YouTube OAuth client ID, client secret and refresh token are required");
  }
  const body = new URLSearchParams({
    client_id: env.YOUTUBE_CLIENT_ID,
    client_secret: env.YOUTUBE_CLIENT_SECRET,
    refresh_token: env.YOUTUBE_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const data = (await response.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!response.ok || !data.access_token) throw new Error(`YouTube OAuth refresh failed: ${data.error_description ?? data.error ?? response.status}`);
  return data.access_token;
}

function videoSourceHeaders(env: YouTubeEnv, videoUrl: string): Record<string, string> {
  const url = new URL(videoUrl);
  const isPrivateGithubAsset = url.hostname === "api.github.com" && /\/releases\/assets\/\d+$/.test(url.pathname);
  if (!isPrivateGithubAsset) return {};
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required to download the private draft render asset");
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/octet-stream",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "musica-salvaje-agent"
  };
}

export async function uploadYouTubePrivate(env: YouTubeEnv, videoUrl: string, metadata: SeoMetadata): Promise<YouTubeUploadResult> {
  const accessToken = await getAccessToken(env);
  const source = await fetch(videoUrl, { redirect: "follow", headers: videoSourceHeaders(env, videoUrl) });
  if (!source.ok || !source.body) throw new Error(`Video download failed HTTP ${source.status}`);
  const contentType = source.headers.get("content-type") ?? "video/mp4";
  const contentLength = source.headers.get("content-length");

  const session = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": contentType,
      ...(contentLength ? { "X-Upload-Content-Length": contentLength } : {})
    },
    body: JSON.stringify({
      snippet: {
        title: metadata.title,
        description: metadata.description,
        tags: metadata.tags,
        categoryId: metadata.categoryId,
        defaultLanguage: metadata.defaultLanguage
      },
      status: {
        privacyStatus: "private",
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: env.YOUTUBE_CONTAINS_SYNTHETIC_MEDIA !== "false",
        embeddable: true,
        license: "youtube",
        publicStatsViewable: true
      }
    })
  });
  if (!session.ok) throw new Error(`YouTube upload session failed HTTP ${session.status}: ${await session.text()}`);
  const uploadUrl = session.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube did not return a resumable upload URL");

  const uploadHeaders: Record<string, string> = { Authorization: `Bearer ${accessToken}`, "Content-Type": contentType };
  if (contentLength) uploadHeaders["Content-Length"] = contentLength;
  const upload = await fetch(uploadUrl, { method: "PUT", headers: uploadHeaders, body: source.body });
  const result = (await upload.json()) as { id?: string; error?: { message?: string } };
  if (!upload.ok || !result.id) throw new Error(`YouTube video upload failed HTTP ${upload.status}: ${result.error?.message ?? "unknown error"}`);
  return { videoId: result.id, url: `https://www.youtube.com/watch?v=${result.id}`, privacyStatus: "private" };
}

export async function publishYouTubeVideo(env: YouTubeEnv, videoId: string): Promise<YouTubeUploadResult> {
  const accessToken = await getAccessToken(env);
  const response = await fetch("https://www.googleapis.com/youtube/v3/videos?part=status", {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: videoId,
      status: {
        privacyStatus: "public",
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: env.YOUTUBE_CONTAINS_SYNTHETIC_MEDIA !== "false",
        embeddable: true,
        license: "youtube",
        publicStatsViewable: true
      }
    })
  });
  const result = (await response.json()) as { id?: string; status?: { privacyStatus?: string }; error?: { message?: string } };
  if (!response.ok || !result.id) throw new Error(`YouTube publish failed HTTP ${response.status}: ${result.error?.message ?? "unknown error"}`);
  return { videoId: result.id, url: `https://www.youtube.com/watch?v=${result.id}`, privacyStatus: (result.status?.privacyStatus as "public" | undefined) ?? "public" };
}
