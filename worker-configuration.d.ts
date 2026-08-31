import type { MusicaSalvajeAgent } from "./src/server";

declare global {
  interface Env {
    MusicaSalvajeAgent: DurableObjectNamespace<MusicaSalvajeAgent>;
    ASSETS: Fetcher;
    TEST_MODE?: string;
    LYRICS_PROVIDER?: "mock" | "groq" | "xai";
    PUBLIC_BASE_URL?: string;
    GROQ_API_KEY?: string;
    GROQ_MODEL?: string;
    XAI_API_KEY?: string;
    XAI_MODEL?: string;
    SUNO_API_KEY?: string;
    SUNO_BASE_URL?: string;
    SUNO_MODEL?: string;
    QUALITY_GATE?: string;
    MAX_DAILY_PAID_GENERATIONS?: string;
    MIN_SUNO_CREDITS?: string;
  }
}

export {};
