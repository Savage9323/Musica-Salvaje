import { describe, expect, it } from "vitest";
import { clampScore, mockLyrics, passesQuality, sha256 } from "../src/providers";

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
});
