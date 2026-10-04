#!/usr/bin/env bash
set -euo pipefail

# Builds the llama-server + Gemma 4 sidecar image on Cloud Build (amd64 CUDA) and pushes it as
# package `model`, which the Artifact Registry cleanup policy caps at 2 versions.

SERVICE="soundboard"
REGION="us-central1"

command -v gcloud > /dev/null || { echo "Error: gcloud CLI is not installed." >&2; exit 1; }

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . ".env"
  set +a
fi

if [[ -z "${GCP_PROJECT_ID:-}" ]]; then
  echo "Error: required env var 'GCP_PROJECT_ID' is missing or empty." >&2
  exit 1
fi

# The tag is the git tree hash of model/: content-addressed, so it survives rebases and squash
# merges, and an unchanged Dockerfile never pays for a second build.
if ! git diff --quiet HEAD -- model; then
  echo "Error: commit model/ changes before building the image." >&2
  exit 1
fi
MODEL_TREE="$(git rev-parse --short=12 HEAD:model)"
IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${SERVICE}/model:${MODEL_TREE}"

if gcloud artifacts docker images describe "$IMAGE" --project "$GCP_PROJECT_ID" &> /dev/null; then
  echo "Already built: $IMAGE"
else
  gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com \
    --project "$GCP_PROJECT_ID" --quiet
  if ! gcloud artifacts repositories describe "$SERVICE" \
    --location "$REGION" --project "$GCP_PROJECT_ID" --quiet &> /dev/null; then
    gcloud artifacts repositories create "$SERVICE" \
      --repository-format docker --location "$REGION" --project "$GCP_PROJECT_ID"
  fi
  # Downloading and pushing ~7 GB of weights outlasts Cloud Build's 10-minute default timeout.
  gcloud builds submit model --tag "$IMAGE" --timeout 3600s --project "$GCP_PROJECT_ID"
fi

echo "MODEL_IMAGE=$IMAGE"
