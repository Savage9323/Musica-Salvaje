# Música Salvaje Agent

Música Salvaje is moving from the former n8n workflow into a custom Cloudflare Agents/Workers service with strict cost controls.

## Current branch capabilities

- $0 mock mode for end-to-end agent testing
- Groq free-tier adapter for no-Suno lyric tests
- xAI/Grok adapter for production finished lyrics
- automatic lyric revision before any paid music generation
- hard quality gate (default 8/10 overall; every dimension >= 7)
- request hashing/idempotency to prevent duplicate paid generations
- daily paid-generation cap
- SunoAPI.org credit preflight
- authenticated Suno callback URL in live mode
- durable callback-recovery polling via Cloudflare Agent schedules
- two Suno result tracks normalized from one generation task
- retry-safe GitHub Actions + FFmpeg rendering
- release polling instead of a fixed 3-minute wait
- downstream render retries never regenerate or recharge music

## Free test path

```bash
npm install
npm run check
npm run dev
```

Defaults are intentionally safe:

```text
TEST_MODE=true
LYRICS_PROVIDER=mock
QUALITY_GATE=8
MAX_LYRIC_REVISIONS=2
MAX_DAILY_PAID_GENERATIONS=2
```

POST a test song:

```bash
curl -X POST http://localhost:8787/api/songs \
  -H 'Content-Type: application/json' \
  -d '{"idea":"Un padre deja su pueblo para trabajar y cumplir una promesa a su familia","testOnly":true}'
```

This path uses generated WAV/SVG fixtures and spends no Suno or xAI credits.

## Live secrets required later

Never commit these values. Store them with Cloudflare secrets/configuration:

```text
XAI_API_KEY
SUNO_API_KEY
SUNO_CALLBACK_SECRET
GITHUB_TOKEN
```

Live mode additionally needs an HTTPS `PUBLIC_BASE_URL`. `SUNO_CALLBACK_SECRET` protects the callback route because the provider callback contract does not include a signed webhook mechanism.

## Recovery behavior

Suno completion can arrive by callback. The agent also polls `record-info` with durable backoff so a lost callback does not strand a paid generation. After audio is ready, rendering is dispatched once and the agent polls for the GitHub release asset. A render failure can be retried independently without another Suno request.

## Production progression

`REQUESTED -> LYRICS_GENERATING -> LYRICS_QA -> READY_FOR_MUSIC -> MUSIC_GENERATING -> AUDIO_READY -> RENDERING -> VIDEO_READY`

Failure/guard states include `QUALITY_REJECTED`, `BUDGET_BLOCKED`, `MUSIC_FAILED`, and `RENDER_FAILED`.
