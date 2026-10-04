#!/usr/bin/env bash
set -euo pipefail

# Cuts the loudest 30 seconds of a finished FLR video, uploads it under samples/, and registers it
# as a one-tap home-page sample tied to its live YouTube video (for the current-vs-proposed diff).
#
# Usage: scripts/add-sample.sh <video-file> <youtube-video-id> "<song title>"

[[ $# -eq 3 ]] || { echo "Usage: $0 <video-file> <youtube-video-id> \"<song title>\"" >&2; exit 1; }
SOURCE=$1 VIDEO_ID=$2 SONG_TITLE=$3
CLIP_SEC=30

for tool in ffmpeg ffprobe gcloud curl; do
  command -v "$tool" > /dev/null || { echo "Error: $tool is not installed." >&2; exit 1; }
done
if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . ".env"
  set +a
fi
: "${GCP_PROJECT_ID:?set GCP_PROJECT_ID}" "${GCS_BUCKET:?set GCS_BUCKET}"

duration="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SOURCE")"

# Momentary loudness every 100 ms, then the 30 s window with the highest mean energy.
start="$(ffmpeg -hide_banner -nostats -i "$SOURCE" -vn \
  -af "ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=-" -f null - 2> /dev/null |
  awk -v win="$CLIP_SEC" -v dur="$duration" '
    /pts_time:/ { split($0, a, "pts_time:"); t = a[2] + 0 }
    /lavfi.r128.M=/ {
      split($0, b, "="); m = b[2] + 0; if (m < -70) m = -70
      n++; ts[n] = t; e[n] = 10 ^ (m / 10)
    }
    END {
      step = (n > 1) ? ts[2] - ts[1] : 0.1; size = int(win / step); best = 0; sum = 0; bestSum = -1
      for (i = 1; i <= n; i++) {
        sum += e[i]; if (i > size) sum -= e[i - size]
        if (i >= size && sum > bestSum) { bestSum = sum; best = ts[i - size + 1] }
      }
      if (best + win > dur) best = (dur > win) ? dur - win : 0
      printf "%.2f", best
    }')"

id="$(printf '%s' "$VIDEO_ID" | tr -cd 'A-Za-z0-9_-')"
clip="$(mktemp --suffix .mp4)"
trap 'rm -f "$clip"' EXIT
echo "Cutting ${CLIP_SEC}s from ${start}s of $SOURCE"
ffmpeg -hide_banner -loglevel error -y -ss "$start" -t "$CLIP_SEC" -i "$SOURCE" \
  -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 192k -movflags +faststart "$clip"

object="samples/${id}.mp4"
gcloud storage cp "$clip" "gs://${GCS_BUCKET}/${object}" --project "$GCP_PROJECT_ID" \
  --content-type video/mp4

body="$(printf '{"fields":{"songTitle":{"stringValue":%s},"videoId":{"stringValue":"%s"},"object":{"stringValue":"%s"},"durationSec":{"integerValue":"%d"}}}' \
  "$(printf '%s' "$SONG_TITLE" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')" "$id" "$object" "$CLIP_SEC")"
curl -fsS -X PATCH \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://firestore.googleapis.com/v1/projects/${GCP_PROJECT_ID}/databases/(default)/documents/samples/${id}" \
  -d "$body" > /dev/null
echo "Sample '${SONG_TITLE}' registered as samples/${id}"
