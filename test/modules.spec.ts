import { describe, expect, it } from "vitest";
import { archiveTracks, mediaUrl } from "../src/media";
import { buildSeoMetadata } from "../src/publishing";
import type { MusicTrack, SongRecord } from "../src/types";

describe("free provider modules", () => {
  it("keeps media untouched when R2 is not configured", async () => {
    const tracks: MusicTrack[] = [{ id: "a", audioUrl: "https://example.com/a.mp3", title: "A" }];
    await expect(archiveTracks({}, "MS-1", tracks)).resolves.toEqual(tracks);
  });

  it("builds stable Worker media URLs", () => {
    expect(mediaUrl("https://music.example.com/", "MS-1/audio 1.mp3")).toBe("https://music.example.com/api/media/MS-1/audio%201.mp3");
  });

  it("builds YouTube metadata without another AI call", () => {
    const song: SongRecord = {
      catalogId: "MS-1",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      requestHash: "hash",
      idea: "Una historia de trabajo, familia y sacrificio en el camino",
      title: "Camino y Palabra",
      lyrics: "[Verse 1]\nTrabajo por mi familia\n[Chorus]\nSigo firme en el camino",
      stylePrompt: "regional Mexican corrido",
      qualityScore: 9,
      status: "VIDEO_READY",
      lyricsProvider: "mock",
      musicProvider: "mock",
      providerTaskId: "mock",
      audioUrls: ["https://example.com/a.mp3"],
      coverUrl: null,
      paidGeneration: false,
      error: null
    };
    const seo = buildSeoMetadata(song);
    expect(seo.title).toContain("Camino y Palabra");
    expect(seo.categoryId).toBe("10");
    expect(seo.tags.length).toBeGreaterThan(5);
    expect(seo.description).toContain("LETRA");
    expect(seo.description).toContain("inteligencia artificial");
  });
});
