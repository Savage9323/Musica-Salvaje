import type { LyricsPackage, MusicResult, MusicTaskStatus, SongRequest } from "./types";

const GITHUB_API = "https://api.github.com";

function githubHeaders(env: Env, accept = "application/vnd.github+json"): Record<string, string> {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required for ACE-Step GitHub generation");
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "musica-salvaje-agent"
  };
}

function repository(env: Env): string {
  const value = env.GITHUB_REPO ?? "Savage9323/Musica-Salvaje";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("Invalid GITHUB_REPO");
  return value;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function privatePayload(request: SongRequest, pkg: LyricsPackage, durationSeconds: number) {
  const negative = pkg.negativeStyles.filter(Boolean).slice(0, 12).join(", ");
  const caption = `${pkg.stylePrompt.trim()}${negative ? `; avoid: ${negative}` : ""}`.slice(0, 1200);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] % 2_147_483_647;
  return {
    title: pkg.title.slice(0, 120),
    caption,
    lyrics: request.instrumental ? "[Instrumental]" : pkg.lyrics.slice(0, 7000),
    instrumental: request.instrumental === true,
    language: request.language ?? "es",
    durationSeconds,
    seed
  };
}

async function deleteDraftReleaseBestEffort(env: Env, releaseId: number): Promise<void> {
  try {
    await fetch(`${GITHUB_API}/repos/${repository(env)}/releases/${releaseId}`, {
      method: "DELETE",
      headers: githubHeaders(env)
    });
  } catch {
    // Cleanup is best-effort. A draft release is private and can be removed later.
  }
}

export async function stageAceStepTask(
  env: Env,
  request: SongRequest,
  pkg: LyricsPackage
): Promise<MusicResult> {
  if (env.ACE_STEP_ENABLED !== "true") {
    throw new Error("FREE_PROVIDER_NOT_READY: ACE-Step GitHub generation is disabled until the duration/memory gate passes");
  }
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required for ACE-Step GitHub generation");

  const maxDuration = positiveInt(env.ACE_STEP_MAX_DURATION_SECONDS, 30);
  const defaultDuration = Math.min(positiveInt(env.ACE_STEP_DEFAULT_DURATION_SECONDS, 30), maxDuration);
  const durationSeconds = Math.trunc(Number(request.durationSeconds ?? defaultDuration));
  if (!Number.isFinite(durationSeconds) || durationSeconds < 10 || durationSeconds > maxDuration) {
    throw new Error(`FREE_PROVIDER_LIMIT: ACE-Step duration must be between 10 and ${maxDuration} seconds`);
  }

  const repo = repository(env);
  const tagName = `ace-${crypto.randomUUID()}`;
  const releaseResponse = await fetch(`${GITHUB_API}/repos/${repo}/releases`, {
    method: "POST",
    headers: { ...githubHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: tagName,
      name: "Private Música Salvaje ACE-Step task",
      body: "Private staging only. Never publish this release.",
      draft: true,
      prerelease: false,
      generate_release_notes: false
    })
  });
  const release = await releaseResponse.json().catch(() => ({})) as { id?: number; upload_url?: string; message?: string };
  if (!releaseResponse.ok || !release.id || !release.upload_url) {
    throw new Error(`ACE-Step draft staging failed HTTP ${releaseResponse.status}: ${release.message ?? "unknown GitHub error"}`);
  }

  try {
    const uploadBase = release.upload_url.replace(/\{.*$/, "");
    if (!uploadBase.startsWith("https://uploads.github.com/")) throw new Error("Unexpected GitHub release upload URL");
    const payload = JSON.stringify(privatePayload(request, pkg, durationSeconds));
    const requestUpload = await fetch(`${uploadBase}?name=request.json`, {
      method: "POST",
      headers: {
        ...githubHeaders(env),
        "Content-Type": "application/json",
        "Content-Length": String(new TextEncoder().encode(payload).byteLength)
      },
      body: payload
    });
    if (!requestUpload.ok) throw new Error(`Private ACE-Step request upload failed HTTP ${requestUpload.status}: ${await requestUpload.text()}`);

    const workflow = env.ACE_STEP_WORKFLOW ?? "ace-step-generate.yml";
    if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow)) throw new Error("Invalid ACE_STEP_WORKFLOW");
    const ref = env.ACE_STEP_REF ?? "main";
    if (!/^[A-Za-z0-9_./-]+$/.test(ref)) throw new Error("Invalid ACE_STEP_REF");
    const dispatch = await fetch(`${GITHUB_API}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: "POST",
      headers: { ...githubHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ ref, inputs: { release_id: String(release.id) } })
    });
    if (!dispatch.ok) throw new Error(`ACE-Step workflow dispatch failed HTTP ${dispatch.status}: ${await dispatch.text()}`);

    return {
      provider: "ace-step-github",
      billing: "free",
      polling: "github-draft",
      taskId: String(release.id),
      tracks: []
    };
  } catch (error) {
    await deleteDraftReleaseBestEffort(env, release.id);
    throw error;
  }
}

export async function getAceStepTaskStatus(env: Env, taskId: string): Promise<MusicTaskStatus> {
  if (!/^\d+$/.test(taskId)) return { status: "FAILED", providerStatus: "INVALID_TASK", tracks: [], error: "Invalid ACE-Step draft release ID" };
  const response = await fetch(`${GITHUB_API}/repos/${repository(env)}/releases/${taskId}`, {
    headers: githubHeaders(env)
  });
  if (response.status === 404) return { status: "FAILED", providerStatus: "STAGING_MISSING", tracks: [], error: "ACE-Step private draft release is missing" };
  const release = await response.json().catch(() => ({})) as {
    draft?: boolean;
    assets?: Array<{ id?: number; name?: string; url?: string }>;
    message?: string;
  };
  if (!response.ok) throw new Error(`ACE-Step task status HTTP ${response.status}: ${release.message ?? "unknown GitHub error"}`);
  if (release.draft !== true) return { status: "FAILED", providerStatus: "PRIVACY_VIOLATION", tracks: [], error: "ACE-Step staging release is no longer private/draft" };

  const assets = release.assets ?? [];
  if (assets.some((asset) => asset.name === "failure.txt")) {
    return { status: "FAILED", providerStatus: "WORKFLOW_FAILED", tracks: [], error: "ACE-Step GitHub generation failed; no paid fallback was attempted" };
  }
  const audio = assets.find((asset) => asset.name === "ace-step.wav" && asset.url && asset.id);
  if (audio?.url && audio.id) {
    return {
      status: "SUCCESS",
      providerStatus: "PRIVATE_AUDIO_READY",
      tracks: [{ id: `ace-step-${audio.id}`, audioUrl: audio.url, title: "ACE-Step private output" }]
    };
  }
  return { status: "PENDING", providerStatus: "GITHUB_WORKFLOW_RUNNING", tracks: [] };
}

export async function cleanupAceStepTask(env: Env, taskId: string): Promise<void> {
  if (!/^\d+$/.test(taskId)) return;
  await deleteDraftReleaseBestEffort(env, Number(taskId));
}
