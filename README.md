# Música Salvaje Agent

Custom autonomous music-production agent replacing the former n8n workflow.

## Current architecture

```text
Studio UI
  -> live-spend gateway
  -> Cloudflare Agent / Durable Object catalog
  -> Grok/xAI finished lyrics + automatic QA/revision
  -> SunoAPI.org Custom Mode (only intended paid music step)
  -> R2 archival
  -> GitHub Actions + FFmpeg render
  -> deterministic SEO metadata
  -> private YouTube upload
  -> explicit approval
  -> public YouTube publish
```

## Cost-first behavior

The repository is safe by default:

```text
TEST_MODE=true
LIVE_GENERATION_ENABLED=false
LYRICS_PROVIDER=mock
MAX_DAILY_PAID_GENERATIONS=2
MAX_MONTHLY_PAID_GENERATIONS=0
```

`MAX_MONTHLY_PAID_GENERATIONS=0` intentionally locks live generation. Production cannot reserve a paid-generation attempt until both daily and monthly limits are explicit positive integers.

The gateway also requires `ADMIN_API_TOKEN` when `TEST_MODE=false`. This prevents a public Worker endpoint from being used by strangers to spend Suno credits.

## $0 test coverage

The project can be developed and validated without xAI, Suno or YouTube credentials:

- mock finished lyrics
- automatic mock quality scores
- two mock music candidates
- generated WAV fixture
- generated SVG cover
- local Durable Object SQLite
- local R2 simulation
- deterministic SEO metadata
- mocked Grok structured-output/revision HTTP contract
- mocked Suno credit, generation and record-info contracts
- mocked YouTube OAuth and resumable private upload
- synthetic GitHub Actions FFmpeg rendering
- duplicate/idempotency tests
- daily/monthly budget-ledger tests
- explicit-approval publish tests

Run locally:

```bash
npm install
npm run check
npm run dev
```

Then create a free test song:

```bash
curl -X POST http://localhost:8787/api/songs \
  -H 'Content-Type: application/json' \
  -d '{"idea":"Un padre deja su pueblo para trabajar y cumplir una promesa a su familia","testOnly":true}'
```

## Finished lyric generation

Production lyrics use xAI/Grok. Groq can be used as an optional no-Suno test provider.

The lyric engine uses schema-constrained JSON, scores ten quality dimensions, and automatically rewrites a finished song up to the configured revision limit before any music-generation call is allowed.

Default gate:

- overall score >= 8.0
- every quality dimension >= 7.0
- maximum automatic revisions: 2
- real artist names are converted to generic musical traits rather than passed downstream

## Suno cost protection

Before a live SunoAPI.org request the system:

1. validates the request and idempotency hash;
2. finishes lyric generation;
3. runs the hard quality gate and automatic revisions;
4. checks the live-generation switch;
5. authenticates the admin request;
6. reserves a serialized daily/monthly budget slot;
7. checks Suno credits;
8. sends one Custom Mode generation request.

The generation task is recovered through both callback handling and `record-info` polling. Downstream failures never intentionally trigger another music generation.

## Media retention and rendering

Live audio/cover URLs can be copied into Cloudflare R2 under the `MEDIA` binding before rendering. This avoids depending on temporary provider URLs.

Rendering uses `.github/workflows/ffmpeg.yml`. The workflow validates source media, renders H.264/AAC with `faststart`, and upserts the catalog-ID release asset with `--clobber`, so a render retry is idempotent.

The Agent polls the GitHub release instead of using a fixed sleep.

## YouTube publishing

Once video is ready, the Agent prepares SEO metadata without another model call. If YouTube credentials are configured, it uses a resumable upload with:

- privacy: private
- category: Music (10)
- made-for-kids: false
- synthetic-media disclosure enabled by default
- subscriber notification disabled during upload

Public publishing is a separate action and requires an explicit `approved: true` request.

## Runtime states

```text
REQUESTED
-> LYRICS_GENERATING
-> LYRICS_QA
-> READY_FOR_MUSIC
-> MUSIC_GENERATING
-> AUDIO_READY
-> RENDERING
-> VIDEO_READY
-> READY_TO_PUBLISH
-> PUBLISHED
```

Guard/failure states include `QUALITY_REJECTED`, `BUDGET_BLOCKED`, `MUSIC_FAILED`, `RENDER_FAILED`, and `UPLOAD_FAILED`.

## Secrets required only for live production

Never commit these values:

```text
ADMIN_API_TOKEN
XAI_API_KEY
SUNO_API_KEY
SUNO_CALLBACK_SECRET
GITHUB_TOKEN
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
YOUTUBE_REFRESH_TOKEN
```

Use Cloudflare secrets / provider secret stores in production.

## Owner-only launch steps not required for $0 CI

Before the first real end-to-end song, the project will need:

- Cloudflare account authorization and the `musica-salvaje-media` R2 bucket
- xAI API credential
- SunoAPI.org API credential/credits
- GitHub credential usable by the deployed Worker for workflow dispatch
- Google/YouTube OAuth credentials and channel authorization
- an explicit monthly paid-generation limit

The first live Suno test should remain capped to one reserved generation attempt so actual credits-per-request can be measured before raising limits.
