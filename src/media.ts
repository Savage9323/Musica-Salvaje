import type { MusicTrack } from "./types";

export interface MediaEnv {
  MEDIA?: R2Bucket;
  PUBLIC_BASE_URL?: string;
}

function extensionFor(contentType: string | null, fallback: "audio" | "image"): string {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp"
  };
  return map[type] ?? (fallback === "audio" ? "mp3" : "jpg");
}

export function mediaUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/media/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function fetchForArchive(url: string, kind: "audio" | "image"): Promise<{ body: ReadableStream; contentType: string; extension: string }> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Archive download failed HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? (kind === "audio" ? "audio/mpeg" : "image/jpeg");
  return { body: response.body, contentType, extension: extensionFor(contentType, kind) };
}

export async function archiveTracks(env: MediaEnv, catalogId: string, tracks: MusicTrack[]): Promise<MusicTrack[]> {
  if (!env.MEDIA) return tracks;
  if (!env.PUBLIC_BASE_URL?.startsWith("https://")) throw new Error("PUBLIC_BASE_URL must be HTTPS before archiving live media");
  const archived: MusicTrack[] = [];
  let archivedCoverUrl: string | undefined;

  for (let index = 0; index < tracks.length; index++) {
    const track = tracks[index];
    const audio = await fetchForArchive(track.audioUrl, "audio");
    const audioKey = `${catalogId}/audio-${index + 1}.${audio.extension}`;
    await env.MEDIA.put(audioKey, audio.body, { httpMetadata: { contentType: audio.contentType }, customMetadata: { catalogId, source: "sunoapi.org", trackId: track.id } });

    if (!archivedCoverUrl && track.imageUrl) {
      const image = await fetchForArchive(track.imageUrl, "image");
      const imageKey = `${catalogId}/cover.${image.extension}`;
      await env.MEDIA.put(imageKey, image.body, { httpMetadata: { contentType: image.contentType }, customMetadata: { catalogId, source: "sunoapi.org" } });
      archivedCoverUrl = mediaUrl(env.PUBLIC_BASE_URL, imageKey);
    }

    archived.push({ ...track, audioUrl: mediaUrl(env.PUBLIC_BASE_URL, audioKey), imageUrl: archivedCoverUrl ?? track.imageUrl });
  }
  return archived;
}

export async function serveArchivedMedia(bucket: R2Bucket, encodedKey: string): Promise<Response> {
  const key = encodedKey.split("/").map(decodeURIComponent).join("/");
  if (!key || key.includes("..")) return new Response("Invalid media key", { status: 400 });
  const object = await bucket.get(key);
  if (!object) return new Response("Media not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}
