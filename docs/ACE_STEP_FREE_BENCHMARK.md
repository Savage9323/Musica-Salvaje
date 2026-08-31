# ACE-Step 1.5 Free-Compute Feasibility Gate

Música Salvaje is testing ACE-Step 1.5 as the default zero-recurring-API-cost music engine. This document defines the evidence required before it can replace or precede Suno in the production provider chain.

## What this test proves

The manual `ACE-Step Free CPU Benchmark` workflow runs on a standard GitHub-hosted Ubuntu runner in the public repository. It does not call xAI, Groq, Suno, YouTube, Cloudflare AI, or any other paid model/API.

The first benchmark intentionally uses:

- pinned ACE-Step upstream commit `ca1e85fe9430179831e6bc6be790c332190a3866`
- CPU device
- PyTorch (`pt`) backend
- DiT-only inference (`ACESTEP_INIT_LLM=false`)
- ACE-Step turbo model
- external caption supplied by Música Salvaje
- no ACE-Step language-model reasoning or lyric generation
- one deterministic instrumental output
- 10 seconds by default

The upstream checkout is patched only inside the disposable Actions runner so Linux resolves CPU PyTorch wheels rather than CUDA wheels. No ACE-Step source is vendored or modified in the Música Salvaje application.

## Why DiT-only is the intended production mode

Música Salvaje already owns the planning, lyric, style, quality, deduplication, and publishing stages. ACE-Step only needs to render audio from the finished caption/lyrics. Initializing ACE-Step's language model would duplicate work, consume substantially more memory/disk, and make CPU feasibility worse.

## Pass criteria

A benchmark is considered technically successful only when all of the following are true:

1. The pinned environment installs on the standard runner without exhausting disk.
2. Core ACE-Step models download successfully.
3. The process completes within the workflow's 120-minute hard timeout.
4. At least one WAV/FLAC/MP3 file is produced.
5. `ffprobe` can parse the output and reports non-zero duration/size.
6. Peak memory, disk use, installation time, and generation wall time are captured in the benchmark artifact.

Passing a 10-second benchmark does **not** yet prove 2–3 minute song viability. If 10 seconds passes, increase deliberately to 20/30 seconds, then test a short vocal/lyrics case before considering longer songs.

## Failure policy

A failure is evidence, not a reason to spend money automatically.

If CPU inference is too slow, runs out of RAM/disk, or upstream packaging cannot be made practical on a standard runner:

- do not enable ACE-Step as the production default;
- do not silently switch to Suno;
- preserve the benchmark logs/artifact;
- evaluate another genuinely free compute target or a user-owned/self-hosted ACE-Step worker;
- keep live paid generation behind the existing explicit admin + budget gate.

## Production integration target after a pass

Once feasibility is demonstrated, the intended provider flow is:

```text
Música Salvaje Agent
  -> finished lyrics/style + QA
  -> dispatch ACE-Step GitHub workflow
  -> private draft GitHub audio asset
  -> authenticated Worker polling
  -> archive audio/cover into R2
  -> FFmpeg render
  -> private YouTube upload
  -> explicit approval
  -> public publish
```

Audio staging must use a private draft release (for example `${catalogId}-audio`) or another authenticated mechanism. It must never publish generated audio as a normal public GitHub Release before approval.

## Cost semantics

ACE-Step is open-source software, but compute is never literally costless to the infrastructure provider. The goal here is **zero recurring API charge to the Música Salvaje owner** by using standard public-repository GitHub-hosted runner capacity within GitHub's applicable limits and acceptable-use rules.

The application must continue to report provider/cost state accurately and fail closed if free compute is unavailable.
