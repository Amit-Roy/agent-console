#!/usr/bin/env bash
set -euo pipefail

input="${1:?Usage: finalize.sh rendered.mp4 output-directory [poster-time]}"
output_dir="${2:?Usage: finalize.sh rendered.mp4 output-directory [poster-time]}"
poster_time="${3:-10.4}"
mkdir -p "$output_dir"

ffmpeg -hide_banner -loglevel error -y -ss "$poster_time" -i "$input" \
  -frames:v 1 -q:v 2 "$output_dir/brag.jpg"

# Replace the first frame with the poster while preserving duration and audio timing.
ffmpeg -hide_banner -loglevel error -y -i "$input" -i "$output_dir/brag.jpg" \
  -filter_complex "[0:v][1:v]overlay=0:0:enable='lt(t,0.001)'[video]" \
  -map '[video]' -map '0:a?' -c:v libx264 -preset fast -crf 20 \
  -pix_fmt yuv420p -c:a copy -movflags +faststart "$output_dir/brag.mp4"
