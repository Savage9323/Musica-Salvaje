import type { BudgetGate, MusicaSalvajeAgent } from "./src/gateway";

declare global {
  interface Env {
    MusicaSalvajeAgent: DurableObjectNamespace<MusicaSalvajeAgent>;
    BudgetGate: DurableObjectNamespace<BudgetGate>;
    ASSETS: Fetcher;
    MEDIA?: R2Bucket;
    TEST_MODE?: string;
    LIVE_GENERATION_ENABLED?: string;
    ADMIN_API_TOKEN?: string;
    LYRICS_PROVIDER?: "mock" | "groq" | "xai";
    PUBLIC_BASE_URL?: string;
    GROQ_API_KEY?: string;
    GROQ_MODEL?: string;
    XAI_API_KEY?: string;
    XAI_MODEL?: string;
    SUNO_API_KEY?: string;
    SUNO_CALLBACK_SECRET?: string;
    SUNO_BASE_URL?: string;
    SUNO_MODEL?: string;
    QUALITY_GATE?: string;
    MAX_LYRIC_REVISIONS?: string;
    MAX_DAILY_PAID_GENERATIONS?: string;
    MAX_MONTHLY_PAID_GENERATIONS?: string;
    MIN_SUNO_CREDITS?: string;
    GITHUB_TOKEN?: string;
    GITHUB_REPO?: string;
    GITHUB_RENDER_WORKFLOW?: string;
    GITHUB_RENDER_REF?: string;
    YOUTUBE_CLIENT_ID?: string;
    YOUTUBE_CLIENT_SECRET?: string;
    YOUTUBE_REFRESH_TOKEN?: string;
    YOUTUBE_CONTAINS_SYNTHETIC_MEDIA?: string;
  }
}

export {};
