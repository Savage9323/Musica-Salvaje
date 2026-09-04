#!/usr/bin/env bash
set -euo pipefail

BENCHMARK_DURATION="${BENCHMARK_DURATION:-30}"
ACESTEP_COMMIT="${ACESTEP_COMMIT:-ca1e85fe9430179831e6bc6be790c332190a3866}"

case "$BENCHMARK_DURATION" in
  10|20|30) ;;
  *) echo 'BENCHMARK_DURATION must be 10, 20, or 30 seconds' >&2; exit 2 ;;
esac

command -v python3.12 >/dev/null 2>&1 || { echo 'python3.12 is required on the self-hosted agent' >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo 'git is required' >&2; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { echo 'ffmpeg/ffprobe is required' >&2; exit 1; }
command -v /usr/bin/time >/dev/null 2>&1 || { echo '/usr/bin/time is required' >&2; exit 1; }

rm -rf benchmark ace-step
mkdir -p benchmark
{
  echo '# ACE-Step 1.5 free CPU benchmark'
  echo
  echo "- Started (UTC): $(date -u +%FT%TZ)"
  echo "- Upstream commit: $ACESTEP_COMMIT"
  echo "- Requested duration: $BENCHMARK_DURATION seconds"
  echo
  echo '## CPU'
  echo '```'
  lscpu | sed -n '1,24p'
  echo '```'
  echo
  echo '## Memory'
  echo '```'
  free -h
  echo '```'
  echo
  echo '## Disk'
  echo '```'
  df -h /
  echo '```'
} > benchmark/report.md

python3.12 -m pip install --disable-pip-version-check --user uv
UV_BIN="$(python3.12 -m site --user-base)/bin/uv"
if [ ! -x "$UV_BIN" ]; then UV_BIN="$(command -v uv || true)"; fi
test -x "$UV_BIN" || { echo 'uv installation failed' >&2; exit 1; }
"$UV_BIN" --version | tee benchmark/uv-version.txt
python3.12 --version | tee benchmark/python-version.txt

git clone --filter=blob:none https://github.com/ace-step/ACE-Step-1.5.git ace-step
(
  cd ace-step
  git checkout --detach "$ACESTEP_COMMIT"
  test "$(git rev-parse HEAD)" = "$ACESTEP_COMMIT"
)

python3.12 - <<'PY'
from pathlib import Path
path = Path('ace-step/pyproject.toml')
text = path.read_text()
replacements = {
    '"torch==2.10.0+cu128; sys_platform == \'linux\' and platform_machine == \'x86_64\'"': '"torch==2.10.0+cpu; sys_platform == \'linux\' and platform_machine == \'x86_64\'"',
    '"torchvision==0.25.0+cu128; sys_platform == \'linux\' and platform_machine == \'x86_64\'"': '"torchvision==0.25.0+cpu; sys_platform == \'linux\' and platform_machine == \'x86_64\'"',
    '"torchaudio==2.10.0+cu128; sys_platform == \'linux\' and platform_machine == \'x86_64\'"': '"torchaudio==2.10.0+cpu; sys_platform == \'linux\' and platform_machine == \'x86_64\'"',
    '    "nano-vllm; sys_platform != \'darwin\' or platform_machine != \'arm64\'",\n': '',
}
for old, new in replacements.items():
    if old not in text:
        raise SystemExit(f'Pinned upstream packaging changed; missing expected text: {old}')
    text = text.replace(old, new)
anchor = '[[tool.uv.index]]\nname = "pytorch-cu130"'
if anchor not in text:
    raise SystemExit('Pinned upstream packaging changed; cu130 index anchor missing')
cpu_index = '[[tool.uv.index]]\nname = "pytorch-cpu"\nurl = "https://download.pytorch.org/whl/cpu"\nexplicit = true\n\n'
text = text.replace(anchor, cpu_index + anchor, 1)
shared = '{ index = "pytorch-cu128", marker = "sys_platform == \'win32\' or (sys_platform == \'linux\' and platform_machine == \'x86_64\')" }'
if text.count(shared) != 3:
    raise SystemExit(f'Expected three shared cu128 source entries, found {text.count(shared)}')
split = '{ index = "pytorch-cu128", marker = "sys_platform == \'win32\'" },\n    { index = "pytorch-cpu", marker = "sys_platform == \'linux\' and platform_machine == \'x86_64\'" }'
text = text.replace(shared, split)
path.write_text(text)
PY

START=$(date +%s)
set +e
(cd ace-step && "$UV_BIN" sync --no-dev --python "$(command -v python3.12)") 2>&1 | tee benchmark/install.log
STATUS=${PIPESTATUS[0]}
set -e
END=$(date +%s)
{
  echo
  echo '## Installation'
  echo "- Exit code: $STATUS"
  echo "- Wall time: $((END-START)) seconds"
} >> benchmark/report.md
if [ "$STATUS" -ne 0 ]; then exit "$STATUS"; fi

cat > ace-step/benchmark.toml <<'EOF'
project_root = "."
config_path = "acestep-v15-turbo"
checkpoint_dir = "checkpoints"
backend = "pt"
device = "cpu"
offload_to_cpu = false
offload_dit_to_cpu = false
save_dir = "output"
audio_format = "wav"
caption = "regional Mexican instrumental, accordion, bajo sexto, warm acoustic bass, restrained percussion, emotional cinematic progression, organic live ensemble"
lyrics = "[Instrumental]"
instrumental = true
vocal_language = "es"
task_type = "text2music"
inference_steps = 8
seed = 9323
use_random_seed = false
thinking = false
use_cot_metas = false
use_cot_caption = false
use_cot_lyrics = false
use_cot_language = false
batch_size = 1
EOF
echo "duration = $BENCHMARK_DURATION" >> ace-step/benchmark.toml

START=$(date +%s)
set +e
(cd ace-step && /usr/bin/time -v -o ../benchmark/time.txt "$UV_BIN" run --no-sync python cli.py -c benchmark.toml --backend pt) 2>&1 | tee benchmark/generation.log
STATUS=${PIPESTATUS[0]}
set -e
END=$(date +%s)
{
  echo
  echo '## Generation'
  echo "- Exit code: $STATUS"
  echo "- Wall time: $((END-START)) seconds"
  echo
  echo '### Resource measurements'
  echo '```'
  cat benchmark/time.txt 2>/dev/null || true
  echo '```'
} >> benchmark/report.md
if [ "$STATUS" -ne 0 ]; then exit "$STATUS"; fi

AUDIO=$(find ace-step/output -type f \( -iname '*.wav' -o -iname '*.flac' -o -iname '*.mp3' \) -print -quit)
test -n "$AUDIO" || { echo 'No generated audio file found' >&2; exit 1; }
echo "$AUDIO" > benchmark/audio-path.txt
ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 "$AUDIO" | tee benchmark/ffprobe.txt
EXT="${AUDIO##*.}"
cp "$AUDIO" "benchmark/ace-step-sample.$EXT"
{
  echo
  echo '## Output validation'
  echo '```'
  cat benchmark/ffprobe.txt
  echo '```'
  echo
  echo '**Result: ACE-Step produced a valid audio file on the configured self-hosted CPU runner.**'
} >> benchmark/report.md
cat benchmark/report.md
