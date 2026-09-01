export type SongStatus =
  | "REQUESTED"
  | "LYRICS_GENERATING"
  | "LYRICS_QA"
  | "QUALITY_REJECTED"
  | "READY_FOR_MUSIC"
  | "BUDGET_BLOCKED"
  | "MUSIC_GENERATING"
  | "AUDIO_READY"
  | "MUSIC_FAILED"
  | "RENDERING"
  | "VIDEO_READY"
  | "RENDER_FAILED"
  | "READY_TO_PUBLISH"
  | "PUBLISHED"
  | "UPLOAD_FAILED";

export interface SongRequest {
  idea: string;
  testOnly?: boolean;
  instrumental?: boolean;
  language?: "es" | "en";
  genre?: string;
  mood?: string[];
}

export interface QualityScores {
  originality: number;
  storytelling: number;
  natural_spanish: number;
  emotional_impact: number;
  singability: number;
  chorus_strength: number;
  rhyme_quality: number;
  regional_authenticity: number;
  style_match: number;
  commercial_potential: number;
}

export interface LyricsPackage {
  title: string;
  lyrics: string;
  stylePrompt: string;
  negativeStyles: string[];
  qualityScores: QualityScores;
  overallScore: number;
  revisionCount: number;
}

export interface MusicTrack {
  id: string;
  audioUrl: string;
  imageUrl?: string;
  durationSeconds?: number;
  title: string;
}

export type MusicProviderId = "mock" | "sunoapi.org" | "ace-step-github";
export type MusicBillingClass = "free" | "paid";
export type MusicPollingStrategy = "none" | "suno" | "github-draft";

export interface MusicResult {
  provider: MusicProviderId;
  billing: MusicBillingClass;
  polling: MusicPollingStrategy;
  taskId: string;
  tracks: MusicTrack[];
  creditsBefore?: number;
  creditsAfter?: number;
}

export interface MusicTaskStatus {
  status: "PENDING" | "SUCCESS" | "FAILED";
  providerStatus: string;
  tracks: MusicTrack[];
  error?: string;
}

export interface SongRecord {
  catalogId: string;
  createdAt: string;
  updatedAt: string;
  requestHash: string;
  idea: string;
  title: string | null;
  lyrics: string | null;
  stylePrompt: string | null;
  qualityScore: number | null;
  status: SongStatus;
  lyricsProvider: string | null;
  musicProvider: string | null;
  providerTaskId: string | null;
  audioUrls: string[];
  coverUrl: string | null;
  paidGeneration: boolean;
  error: string | null;
}

export interface RenderRecord {
  catalogId: string;
  attempt: number;
  status: "IDLE" | "DISPATCHED" | "RUNNING" | "SUCCESS" | "FAILED";
  startedAt: string | null;
  lastCheckedAt: string | null;
  videoUrl: string | null;
  error: string | null;
}
