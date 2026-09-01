import { describe, expect, it } from "vitest";
import { clampScore, configuredMusicProvider, generateMusic, mockLyrics, musicRequestUsesPaidProvider, passesQuality, sha256 } from "../src/providers";

describe("provider utilities", () => {
  it("hashes normalized input deterministically", async () => {
    expect(await sha256("  Hola Mundo ")).toBe(await sha256("hola mundo"));
  });

  it("clamps quality scores", () => {
    expect(clampScore(12)).toBe(10);
    expect(clampScore(-1)).toBe(0);
    expect(clampScore(8.46)).toBe(8.5);
  });

  it("mock lyrics pass the production quality gate", () => {
    const pkg = mockLyrics({ idea: "Un padre trabaja lejos para construir un futuro mejor para su familia" });
    expect(pkg.lyrics).toContain("[Chorus]");
    expect(pkg.overallScore).toBeGreaterThanOrEqual(8);
    expect(passesQuality(pkg, 8)).toBe(true);
  });

  it("classifies paid provider usage before generation", () => {
    const suno = { TEST_MODE: "false", MUSIC_PROVIDER: "sunoapi.org" } as Env;
    const ace = { TEST_MODE: "false", MUSIC_PROVIDER: "ace-step-github" } as Env;
    expect(configuredMusicProvider(suno)).toBe("sunoapi.org");
    expect(configuredMusicProvider(ace)).toBe("ace-step-github");
    expect(musicRequestUsesPaidProvider(suno, { testOnly: false })).toBe(true);
    expect(musicRequestUsesPaidProvider(ace, { testOnly: false })).toBe(false);
    expect(musicRequestUsesPaidProvider(suno, { testOnly: true })).toBe(false);
  });

  it("returns explicit free billing metadata for mock generation", async () => {
    const request = { idea: "Una historia suficientemente detallada para probar el proveedor mock", testOnly: true };
    const pkg = mockLyrics(request);
    const result = await generateMusic({ TEST_MODE: "true", PUBLIC_BASE_URL: "http://localhost:8787" } as Env, request, pkg);
    expect(result.provider).toBe("mock");
    expect(result.billing).toBe("free");
    expect(result.polling).toBe("none");
  });

  it("fails closed when ACE-Step is selected before its benchmark gate passes", async () => {
    const request = { idea: "Una historia suficientemente detallada para probar ACE-Step", testOnly: false };
    const pkg = mockLyrics(request);
    await expect(generateMusic({ TEST_MODE: "false", MUSIC_PROVIDER: "ace-step-github" } as Env, request, pkg))
      .rejects.toThrow("FREE_PROVIDER_NOT_READY");
  });
});
