# Música Salvaje Agent

Custom autonomous music-production agent replacing the former n8n workflow.

## Current architecture

```text
Studio UI
  -> authenticated live-spend gateway
  -> Cloudflare Agent / Durable Object catalog
  -> Grok/xAI finished lyrics + automatic QA/revision
  -> SunoAPI.org Custom Mode (only intended paid music step)
  -> R2 audio/cover archival
  -> GitHub Actions + FFmpeg
  -> private GitHub draft render asset
  -> deterministic SEO metadata
  -> private YouTube upload
  -> explicit human approval
  -> public YouTube publish
```

## Safe defaults

```text
TEST_MODE=true
ALLOW_UNAUTHENTICATED_TEST_API=false
LIVE_GENERATION_ENABLED=false
LYRICS_PROVIDER=mock
MAX_DAILY_PAID_GENERATIONS=2
MAX_MONTHLY_PAID_GENERATIONS=0
```

`MAX_MONTHLY_PAID_GENERATIONS=0` intentionally locks paid generation. Live mode cannot reserve a Suno attempt until both daily and monthly limits are explicit positive integers.

A deployed Worker also fails closed without `ADMIN_API_TOKEN`, including while `TEST_MODE=true`. Only local development should set `ALLOW_UNAUTHENTICATED_TEST_API=true`; `.dev.vars.example` does this explicitly. Production catalog reads and control routes are private, and direct `/agents/*` transport is disabled in production. The Studio keeps its admin token in `sessionStorage` only for the current browser tab.

## $0 validation

Development and CI do not require xAI, Suno or YouTube credentials. Coverage includes:

- mock finished lyrics, quality scores and two audio candidates
- generated WAV and SVG fixtures
- local Durable Object SQLite and R2 simulation
- schema-constrained Grok revision contract
- Suno credit/generation/record-info contracts using mocked HTTP
- YouTube OAuth/resumable private-upload contract using mocked HTTP
- authenticated private GitHub render-asset handoff using mocked HTTP
- synthetic FFmpeg rendering
- duplicate/idempotency tests
- daily/monthly budget ledger tests
- deployed-test and production admin/privacy tests
- explicit-approval publish tests
- frontend JavaScript syntax validation

Run locally:

```bash
cp .dev.vars.example .dev.vars
npm install
npm run check
npm run dev
```

Create a $0 local test song:

```bash
curl -X POST http://localhost:8787/api/songs \
  -H 'Content-Type: application/json' \
  -d '{"idea":"Un padre deja su pueblo para trabajar y cumplir una promesa a su familia","testOnly":true}'
```

## Cloudflare locked test deployment

`.github/workflows/cloudflare-test-deploy.yml` is a **manual-only** deployment workflow. It never enables paid music. It:

1. runs the full repository check;
2. verifies Cloudflare credentials are present;
3. creates `musica-salvaje-media` in R2 if needed;
4. uploads `ADMIN_API_TOKEN` alongside the first Worker deployment;
5. discovers the assigned `workers.dev` URL;
6. redeploys with `PUBLIC_BASE_URL` set to that canonical URL;
7. verifies unauthenticated API access is rejected;
8. creates a mock song with admin auth and confirms paid-generation count remains zero;
9. verifies the generated test audio is reachable.

Required GitHub repository secrets for this locked test deployment:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
MUSICA_SALVAJE_ADMIN_API_TOKEN
```

The Cloudflare API token should be scoped to this account and include Worker deployment access plus R2 storage write access. Do not place any of these values in the repository.

## Lyrics and QA

Production lyrics use xAI/Grok. Groq can be selected for alternative testing.

Before music generation, the lyric engine uses schema-constrained JSON, scores ten dimensions and rewrites the finished song up to the configured revision limit.

Default gate:

- overall score >= 8.0
- every quality dimension >= 7.0
- maximum automatic revisions: 2
- real artist names are converted to generic musical traits rather than passed downstream

## Suno cost protection

Before one live SunoAPI.org Custom Mode request, the system:

1. validates and deduplicates the request;
2. completes lyric generation and automatic revisions;
3. passes the hard quality gate;
4. authenticates the admin request;
5. verifies `LIVE_GENERATION_ENABLED=true`;
6. reserves a serialized daily/monthly budget slot;
7. checks Suno credits;
8. submits one music-generation request.

Reservations expire automatically after 30 minutes if a crashed request leaves one behind. Callback handling and `record-info` polling recover asynchronous Suno jobs. Render, archival and publishing failures never intentionally regenerate paid music.

## Media retention and rendering

Suno audio and cover art are copied into Cloudflare R2 before rendering when the `MEDIA` binding is configured. Archived media responses use `private, no-store` rather than persistent public caching.

`.github/workflows/ffmpeg.yml` validates source media and renders H.264/AAC with `faststart`. The resulting MP4 is stored in a **GitHub draft release**, not a published release. Draft releases are discovered by the Worker using its authenticated GitHub token, and YouTube downloads the draft asset through the authenticated GitHub REST asset endpoint.

This means a rendered song is not exposed as a public GitHub Release before approval. Render retries recreate the same private draft staging release and never regenerate music.

## YouTube publishing

After rendering, deterministic SEO metadata is generated without another model call. When YouTube credentials are configured, the agent uses resumable upload with:

- privacy: private
- category: Music (10)
- made-for-kids: false
- synthetic-media disclosure enabled by default
- subscriber notification disabled during upload

Public publishing is a separate action requiring `approved: true`. The Studio also presents a second confirmation before sending that request.

The Studio can recover downstream failures independently:

- `RENDER_FAILED` -> retry FFmpeg only
- private YouTube upload failed -> retry using the existing rendered MP4
- `PRIVATE_READY` -> explicit approve and publish

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

Guard/failure states include `QUALITY_REJECTED`, `BUDGET_BLOCKED`, `MUSIC_FAILED`, `RENDER_FAILED`, and upload failure states.

## Browser and API hardening

Gateway responses add `nosniff`, no-referrer, frame denial and a restrictive permissions policy. HTML receives a same-origin Content Security Policy. API responses are marked `no-store`.

Suno callbacks do not use the Studio admin token; they use the separate `SUNO_CALLBACK_SECRET`. R2 media remains directly readable so GitHub Actions can render from it, but persistent caching is disabled. Synthetic mock audio/cover endpoints are public only while `TEST_MODE=true`; they cannot spend credits or expose catalog data.

## Live-production secrets

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

Use Cloudflare/provider secret stores.

## Owner-only launch steps

The code and $0 CI can be completed without account access. The first permanent Cloudflare test deployment needs only the three GitHub Cloudflare/admin secrets listed above. Live music remains disabled after that deployment.

A later real end-to-end song additionally requires:

- xAI API credential
- SunoAPI.org API credential/credits
- GitHub credential usable by the deployed Worker for workflow dispatch and private draft assets
- Google/YouTube OAuth credentials plus channel authorization
- an explicit positive monthly generation limit
- changing `TEST_MODE=false` and `LIVE_GENERATION_ENABLED=true` only after those secrets are installed and verified

The first Suno production test should use daily/monthly limits of **1** so real credits consumed per generation can be measured before any increase.
