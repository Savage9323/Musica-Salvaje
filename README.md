# Música Salvaje Agent v1

A no-n8n, cost-guarded music-production agent built on Cloudflare Agents. The default configuration is intentionally **$0 test mode**: no xAI call, no SunoAPI.org call, and no paid music generation.

## Current pipeline

`idea -> idempotency -> finished lyrics -> QA gate -> budget guard -> music provider -> catalog`

Providers are swappable:

- `mock` lyrics + `mock` music: fully local/free test path.
- `groq` lyrics: free-tier live LLM test path; music remains mock while `TEST_MODE=true`.
- `xai` lyrics: production Grok path; music still stays mock until `TEST_MODE=false`.
- `sunoapi.org` music: only used when `TEST_MODE=false` and a key is configured.

The catalog lives in the Agent's SQLite-backed Durable Object, avoiding a separate database for v1.

## Free testing ladder

### Level 0 — unit/integration tests ($0, no accounts)

```bash
npm install
npm run check
```

Cloudflare's local Worker/Durable Object runtime is simulated with Miniflare/Vitest. No cloud deployment is required.

### Level 1 — local studio UI ($0, no accounts)

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

Open the Wrangler URL. `TEST_MODE=true` and `LYRICS_PROVIDER=mock` are the safe defaults.

### Level 2 — real LLM, no music spend ($0 target)

Create a Groq free-tier API key and set:

```dotenv
TEST_MODE=true
LYRICS_PROVIDER=groq
GROQ_API_KEY=...
```

The agent generates real finished lyrics and scores them, but still uses generated test audio. Suno is never called.

### Level 3 — Grok lyrics, mock music (very low cost, zero Suno credits)

```dotenv
TEST_MODE=true
LYRICS_PROVIDER=xai
XAI_API_KEY=...
```

This validates the production lyric provider while keeping the expensive music stage disabled.

### Level 4 — live music generation

Only after Levels 0–3 pass:

```dotenv
TEST_MODE=false
LYRICS_PROVIDER=xai
XAI_API_KEY=...
SUNO_API_KEY=...
PUBLIC_BASE_URL=https://your-worker.example
```

Live generation is blocked unless the quality gate passes, the daily generation cap has room, Suno has enough credits, and `PUBLIC_BASE_URL` is HTTPS for callbacks.

## Spend protection

Defaults:

- `QUALITY_GATE=8`
- every quality dimension must be >= 7
- `MAX_DAILY_PAID_GENERATIONS=2`
- `MIN_SUNO_CREDITS=1`
- duplicate requests return the existing song instead of generating again
- `TEST_MODE=true` by default
- paid-generation count remains zero in test mode

## SunoAPI.org integration

The implementation uses only two endpoints for v1:

- `GET /api/v1/generate/credit` before a paid request
- `POST /api/v1/generate` in custom mode after lyrics pass QA

A live request uses the finished lyrics as the `prompt`, preserving Grok as the lyric writer. The provider documents that a generation request returns two songs, so Música Salvaje does not issue a second paid request just to obtain a variation.

## API

- `GET /health`
- `POST /api/songs` `{ "idea": "...", "testOnly": true }`
- `GET /api/songs`
- `GET /api/songs/:catalogId`
- `GET /api/budget`
- `GET /api/test/audio.wav` in test mode only
- `GET /api/test/cover.svg` in test mode only
- `POST /api/callbacks/suno`

## Secrets

Never commit `.dev.vars` or API keys. For production use `wrangler secret put` for `XAI_API_KEY`, `SUNO_API_KEY`, and any other credential.

## Next production stages

The existing `.github/workflows/ffmpeg.yml` remains the renderer. The next stage after cloud authentication is to wire `AUDIO_READY -> GitHub Actions render -> VIDEO_READY`, then private YouTube upload and explicit publish approval. Those stages must retry independently and must never trigger another Suno generation when rendering or publishing fails.
