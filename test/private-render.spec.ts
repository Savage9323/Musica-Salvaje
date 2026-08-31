import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadYouTubePrivate } from "../src/publishing";

afterEach(() => vi.unstubAllGlobals());

describe("private render handoff", () => {
  it("downloads a draft GitHub release asset with authentication before private YouTube upload", async () => {
    const assetUrl = "https://api.github.com/repos/Savage9323/Musica-Salvaje/releases/assets/321";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "youtube-access" });
      if (url === assetUrl) {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer github-private-token");
        expect(headers.get("accept")).toBe("application/octet-stream");
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": "4" }
        });
      }
      if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos?")) {
        return new Response(null, { status: 200, headers: { location: "https://upload.example.com/private-session" } });
      }
      if (url === "https://upload.example.com/private-session" && init?.method === "PUT") return Response.json({ id: "yt-private-123" });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadYouTubePrivate({
      GITHUB_TOKEN: "github-private-token",
      YOUTUBE_CLIENT_ID: "client",
      YOUTUBE_CLIENT_SECRET: "secret",
      YOUTUBE_REFRESH_TOKEN: "refresh",
      YOUTUBE_CONTAINS_SYNTHETIC_MEDIA: "true"
    }, assetUrl, {
      title: "Private Render Test | Música Salvaje",
      description: "Private staging upload test",
      tags: ["Música Salvaje"],
      hashtags: ["#MusicaSalvaje"],
      categoryId: "10",
      defaultLanguage: "es"
    });

    expect(result.videoId).toBe("yt-private-123");
    expect(result.privacyStatus).toBe("private");
  });

  it("refuses a private GitHub render URL when GitHub auth is missing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "youtube-access" });
      throw new Error("Private render should not be fetched without GitHub auth");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadYouTubePrivate({
      YOUTUBE_CLIENT_ID: "client",
      YOUTUBE_CLIENT_SECRET: "secret",
      YOUTUBE_REFRESH_TOKEN: "refresh"
    }, "https://api.github.com/repos/Savage9323/Musica-Salvaje/releases/assets/999", {
      title: "Blocked",
      description: "Blocked",
      tags: [],
      hashtags: [],
      categoryId: "10",
      defaultLanguage: "es"
    })).rejects.toThrow("GITHUB_TOKEN is required");
  });
});
