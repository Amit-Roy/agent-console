#!/usr/bin/env bash
# Download the Parakeet TDT 0.6b v2 (int8, English) speech model used by voice input.
# Usage: scripts/voice-models.sh   (AGENT_CONSOLE_VOICE_MODELS overrides ~/.cache/agent-console/models)
set -euo pipefail
name="sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
root="${AGENT_CONSOLE_VOICE_MODELS:-$HOME/.cache/agent-console/models}"
url="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$name.tar.bz2"
if [ -f "$root/$name/tokens.txt" ] && [ -f "$root/$name/encoder.int8.onnx" ]; then
  echo "Model already present in $root/$name"
  exit 0
fi
command -v ffmpeg >/dev/null || echo "Warning: ffmpeg is not on PATH; voice input needs it." >&2
mkdir -p "$root"
tmp="$(mktemp -d "$root/.download.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
curl -fL --retry 3 -o "$tmp/model.tar.bz2" "$url"
tar -xjf "$tmp/model.tar.bz2" -C "$tmp"
rm -rf "$root/$name"
mv "$tmp/$name" "$root/$name"
echo "Installed $name in $root"
