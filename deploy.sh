#!/usr/bin/env bash
set -euo pipefail

SERVICE="soundboard"
REGION="${GCP_REGION:-us-central1}"
SEPARATOR="=================================================="

command -v gcloud > /dev/null || { echo "Error: gcloud CLI is not installed." >&2; exit 1; }
command -v envsubst > /dev/null || { echo "Error: envsubst (gettext) is not installed." >&2; exit 1; }

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . ".env"
  set +a
fi

require_env() {
  local name=$1
  if [[ -z "${!name:-}" ]]; then
    echo "Error: required env var '$name' is missing or empty." >&2
    exit 1
  fi
}

# The image tag names a commit, so the build context must be exactly that commit.
if ! git diff --quiet HEAD -- || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "Error: commit or stash local changes before deploying." >&2
  exit 1
fi

require_env GCP_PROJECT_ID
require_env GCS_BUCKET
require_env MODEL_IMAGE

export GCP_PROJECT_ID GCS_BUCKET MODEL_IMAGE
SERVICE_ACCOUNT="${SERVICE}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
GIT_SHA="$(git rev-parse --short HEAD)"
APP_IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${SERVICE}/app:${GIT_SHA}"
export SERVICE_ACCOUNT APP_IMAGE

echo "$SEPARATOR"
echo "Project: $GCP_PROJECT_ID"
echo "Region:  $REGION"
echo "App:     $APP_IMAGE"
echo "Model:   $MODEL_IMAGE"
echo "$SEPARATOR"

gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com run.googleapis.com \
  iam.googleapis.com --project "$GCP_PROJECT_ID" --quiet

# Runtime identity: create it once, and let the deploying account attach it to the service
# (Cloud Run requires iam.serviceAccounts.actAs on a user-managed service account).
if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT" \
  --project "$GCP_PROJECT_ID" --quiet &> /dev/null; then
  gcloud iam service-accounts create "$SERVICE" \
    --display-name "Soundboard runtime" --project "$GCP_PROJECT_ID"
fi
DEPLOYER="$(gcloud config get-value account 2> /dev/null)"
DEPLOYER_TYPE="user"
[[ "$DEPLOYER" == *.gserviceaccount.com ]] && DEPLOYER_TYPE="serviceAccount"
gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT" \
  --member "${DEPLOYER_TYPE}:${DEPLOYER}" --role roles/iam.serviceAccountUser \
  --project "$GCP_PROJECT_ID" --quiet > /dev/null

if ! gcloud artifacts repositories describe "$SERVICE" \
  --location "$REGION" --project "$GCP_PROJECT_ID" --quiet &> /dev/null; then
  gcloud artifacts repositories create "$SERVICE" \
    --repository-format docker --location "$REGION" --project "$GCP_PROJECT_ID"
fi
# Storage is billed per GB: keep the 5 newest app images and the 2 newest model images.
gcloud artifacts repositories set-cleanup-policies "$SERVICE" \
  --location "$REGION" --project "$GCP_PROJECT_ID" \
  --policy cleanup-policy.json --no-dry-run --quiet > /dev/null

gcloud builds submit . --tag "$APP_IMAGE" --project "$GCP_PROJECT_ID"

rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
# Single quotes are deliberate: envsubst takes the variable list literally.
# shellcheck disable=SC2016
envsubst '${SERVICE_ACCOUNT} ${APP_IMAGE} ${MODEL_IMAGE} ${GCP_PROJECT_ID} ${GCS_BUCKET}' \
  < service.yaml > "$rendered"

gcloud run services replace "$rendered" --region "$REGION" --project "$GCP_PROJECT_ID"
gcloud run services add-iam-policy-binding "$SERVICE" \
  --region "$REGION" --project "$GCP_PROJECT_ID" \
  --member allUsers --role roles/run.invoker

echo "$SEPARATOR"
echo "Deployed: $(gcloud run services describe "$SERVICE" --region "$REGION" \
  --project "$GCP_PROJECT_ID" --format 'value(status.url)')"
echo "$SEPARATOR"
