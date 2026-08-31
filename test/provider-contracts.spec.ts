import { afterEach, describe, expect, it, vi } from "vitest";
import { generateLyrics, generateMusic, getSunoTaskStatus } from "../src/providers";
import { uploadYouTubePrivate } from "../src/publishing";
import type { LyricsPackage } from "../src/types";

const scores = (value: number) => ({
  originality: value,
  storytelling: value,
  natural_spanish: value,
  emotional_impact: value,
  singability: value,
  chorus_strength: value,
  rhyme_quality: value,
  regional_authenticity: value,
  style_match: value,
  commercial_potential: value
});

function lyricResponse(score: number, suffix: string) {
  return Response.json({
    choices: [{
      message: {
        content: JSON.stringify({
          title: `Promesa ${suffix}`,
          lyrics: `[Verse 1]\nCamino ${suffix}\n[Chorus]\nSigo firme ${suffix}`,
          stylePrompt: "regional Mexican corrido, 94 BPM, accordion, bajo sexto, emotional vocal",
          negativeStyles: ["EDM"],
          qualityScores: scores(score),
          overallScore: score,
          revisionCount: 99
        })
      }
    }]
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("provider contracts with zero external spend", () => {
  it("automatically revises Grok lyrics before music spend", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lyricResponse(7, "uno"))
      .mockResolvedValueOnce(lyricResponse(9, "dos"));
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      LYRICS_PROVIDER: "xai",
      XAI_API_KEY: "test-key",
      XAI_MODEL: "grok-4.3",
      QUALITY_GATE: "8",
      MAX_LYRIC_REVISIONS: "2"
    } as unknown as Env;
    const result = await generateLyrics(env, { idea: "Una promesa familiar que se cumple a través de muchos años de trabajo" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("xai");
    expect(result.package.overallScore).toBe(9);
    expect(result.package.revisionCount).toBe(1);
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as { messages: Array<{ content: string }> };
    expect(secondRequest.messages[1].content).toContain("previous");
  });

  it("checks Suno credits before submitting one Custom Mode generation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/generate/credit")) return Response.json({ code: 200, data: 500 });
      if (url.endsWith("/generate")) return Response.json({ code: 200, data: { taskId: "task-123" } });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const pkg: LyricsPackage = {
      title: "Promesa",
      lyrics: "[Verse 1]\nTrabajo por mi casa\n[Chorus]\nCumplo mi palabra",
      stylePrompt: "regional Mexican corrido, accordion and bajo sexto",
      negativeStyles: ["EDM"],
      qualityScores: scores(9),
      overallScore: 9,
      revisionCount: 0
    };
    const env = {
      TEST_MODE: "false",
      PUBLIC_BASE_URL: "https://agent.example.com",
      SUNO_API_KEY: "suno-test",
      SUNO_CALLBACK_SECRET: "callback-secret",
      SUNO_BASE_URL: "https://api.sunoapi.org/api/v1",
      SUNO_MODEL: "V5",
      MIN_SUNO_CREDITS: "1"
    } as unknown as Env;

    const result = await generateMusic(env, { idea: "Una historia suficientemente larga para probar Suno" }, pkg);
    expect(result.taskId).toBe("task-123");
    expect(result.creditsBefore).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const generateCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/generate"));
    expect(generateCall).toBeTruthy();
    const body = JSON.parse(String(generateCall?.[1]?.body)) as Record<string, unknown>;
    expect(body.customMode).toBe(true);
    expect(body.prompt).toBe(pkg.lyrics);
    expect(body.callBackUrl).toBe("https://agent.example.com/api/callbacks/suno?token=callback-secret");
  });

  it("normalizes Suno record-info success without another generation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      code: 200,
      data: {
        status: "SUCCESS",
        response: {
          sunoData: [
            { id: "a", audio_url: "https://cdn.example.com/a.mp3", image_url: "https://cdn.example.com/a.jpg", duration: 170, title: "A" },
            { id: "b", audio_url: "https://cdn.example.com/b.mp3", duration: 168, title: "B" }
          ]
        }
      }
    })));
    const env = { SUNO_API_KEY: "test", SUNO_BASE_URL: "https://api.sunoapi.org/api/v1" } as unknown as Env;
    const result = await getSunoTaskStatus(env, "task-123");
    expect(result.status).toBe("SUCCESS");
    expect(result.tracks).toHaveLength(2);
    expect(result.tracks[0].audioUrl).toContain("a.mp3");
  });

  it("tests YouTube OAuth and resumable private upload with mocked HTTP only", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "access-test" });
      if (url === "https://cdn.example.com/video.mp4") {
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "video/mp4", "content-length": "4" } });
      }
      if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos?")) {
        return new Response(null, { status: 200, headers: { location: "https://upload.example.com/session" } });
      }
      if (url === "https://upload.example.com/session" && init?.method === "PUT") return Response.json({ id: "yt-test-123" });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadYouTubePrivate({
      YOUTUBE_CLIENT_ID: "client",
      YOUTUBE_CLIENT_SECRET: "secret",
      YOUTUBE_REFRESH_TOKEN: "refresh",
      YOUTUBE_CONTAINS_SYNTHETIC_MEDIA: "true"
    }, "https://cdn.example.com/video.mp4", {
      title: "Promesa — Regional Mexican | Música Salvaje",
      description: "Descripción",
      tags: ["Música Salvaje"],
      hashtags: ["#MusicaSalvaje"],
      categoryId: "10",
      defaultLanguage: "es"
    });

    expect(result.videoId).toBe("yt-test-123");
    expect(result.privacyStatus).toBe("private");
    const sessionCall = fetchMock.mock.calls.find(([input]) => String(input).startsWith("https://www.googleapis.com/upload/youtube/v3/videos?"));
    const sessionBody = JSON.parse(String(sessionCall?.[1]?.body)) as { status: { privacyStatus: string; containsSyntheticMedia: boolean } };
    expect(sessionBody.status.privacyStatus).toBe("private");
    expect(sessionBody.status.containsSyntheticMedia).toBe(true);
  });
});
