#!/usr/bin/env bash
set -euo pipefail

SERVICE="soundboard"
REGION="us-central1"
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
require_env FLR_CHANNEL_ID
require_env GOOGLE_OAUTH_CLIENT_ID
require_env ALLOWLIST_EMAILS
PUBLIC_SENTRY_DSN="${PUBLIC_SENTRY_DSN:-}"
DEMO_EMAILS="${DEMO_EMAILS:-}"

export GCP_PROJECT_ID GCS_BUCKET MODEL_IMAGE FLR_CHANNEL_ID GOOGLE_OAUTH_CLIENT_ID ALLOWLIST_EMAILS \
  PUBLIC_SENTRY_DSN DEMO_EMAILS
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
  iam.googleapis.com iamcredentials.googleapis.com firestore.googleapis.com \
  secretmanager.googleapis.com --project "$GCP_PROJECT_ID" --quiet

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

# Uploads bucket: private, no soft-delete retention (billed storage), objects gone after 7 days.
if ! gcloud storage buckets describe "gs://${GCS_BUCKET}" --project "$GCP_PROJECT_ID" &> /dev/null; then
  gcloud storage buckets create "gs://${GCS_BUCKET}" --project "$GCP_PROJECT_ID" \
    --location "$REGION" --default-storage-class STANDARD \
    --uniform-bucket-level-access --public-access-prevention --soft-delete-duration 0
fi
# Reconciled on every deploy, not just at creation, so an existing or drifted bucket gets the
# same protections.
gcloud storage buckets update "gs://${GCS_BUCKET}" --project "$GCP_PROJECT_ID" \
  --uniform-bucket-level-access --public-access-prevention --clear-soft-delete \
  --lifecycle-file gcs-lifecycle.json --quiet > /dev/null
gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET}" \
  --member "serviceAccount:${SERVICE_ACCOUNT}" --role roles/storage.objectAdmin \
  --project "$GCP_PROJECT_ID" --quiet > /dev/null
# Cloud Run holds no private key, so signed upload/playback URLs are signed through the IAM
# signBlob API: the runtime identity needs Token Creator on itself.
gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT" \
  --member "serviceAccount:${SERVICE_ACCOUNT}" --role roles/iam.serviceAccountTokenCreator \
  --project "$GCP_PROJECT_ID" --quiet > /dev/null

# Firestore in Native mode. Its location is permanent, so it is created once in the service region.
# Without deployed Firebase rules, client SDK access is denied; only the runtime identity reads it.
if ! gcloud firestore databases describe --database "(default)" --project "$GCP_PROJECT_ID" \
  &> /dev/null; then
  gcloud firestore databases create --location "$REGION" --type firestore-native \
    --project "$GCP_PROJECT_ID" --quiet
fi
gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member "serviceAccount:${SERVICE_ACCOUNT}" --role roles/datastore.user \
  --condition None --quiet > /dev/null

# App secrets come from .env on first deploy (or when the value changes) and live only in Secret
# Manager after that. The runtime identity reads them; it never sees them on disk.
sync_secret() {
  local secret=$1 value=${!2:-}
  if ! gcloud secrets describe "$secret" --project "$GCP_PROJECT_ID" &> /dev/null; then
    [[ -n "$value" ]] || { echo "Error: secret '$secret' is missing; set $2 in .env." >&2; exit 1; }
    gcloud secrets create "$secret" --replication-policy automatic --project "$GCP_PROJECT_ID" --quiet
  fi
  if [[ -n "$value" ]] && [[ "$(gcloud secrets versions access latest --secret "$secret" \
    --project "$GCP_PROJECT_ID" 2> /dev/null)" != "$value" ]]; then
    printf '%s' "$value" | gcloud secrets versions add "$secret" --data-file - \
      --project "$GCP_PROJECT_ID" --quiet > /dev/null
  fi
  gcloud secrets add-iam-policy-binding "$secret" --project "$GCP_PROJECT_ID" \
    --member "serviceAccount:${SERVICE_ACCOUNT}" --role roles/secretmanager.secretAccessor \
    --quiet > /dev/null
}
sync_secret soundboard-session-secret SESSION_SECRET
sync_secret soundboard-oauth-client-secret GOOGLE_OAUTH_CLIENT_SECRET
sync_secret soundboard-youtube-api-key YOUTUBE_API_KEY

# YouTube refresh tokens: the app adds versions when a channel is connected, so it gets accessor and
# version-adder on exactly these two secrets.
for channel in nathan sandbox; do
  secret="yt-refresh-${channel}"
  if ! gcloud secrets describe "$secret" --project "$GCP_PROJECT_ID" &> /dev/null; then
    gcloud secrets create "$secret" --replication-policy automatic --project "$GCP_PROJECT_ID" --quiet
  fi
  for role in roles/secretmanager.secretAccessor roles/secretmanager.secretVersionAdder; do
    gcloud secrets add-iam-policy-binding "$secret" --project "$GCP_PROJECT_ID" \
      --member "serviceAccount:${SERVICE_ACCOUNT}" --role "$role" --quiet > /dev/null
  done
done

gcloud builds submit . --tag "$APP_IMAGE" --project "$GCP_PROJECT_ID"

rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
# Single quotes are deliberate: envsubst takes the variable list literally.
# shellcheck disable=SC2016
envsubst '${SERVICE_ACCOUNT} ${APP_IMAGE} ${MODEL_IMAGE} ${GCP_PROJECT_ID} ${GCS_BUCKET}
  ${FLR_CHANNEL_ID} ${GOOGLE_OAUTH_CLIENT_ID} ${ALLOWLIST_EMAILS} ${DEMO_EMAILS} ${PUBLIC_SENTRY_DSN}' \
  < service.yaml > "$rendered"

gcloud run services replace "$rendered" --region "$REGION" --project "$GCP_PROJECT_ID"
gcloud run services add-iam-policy-binding "$SERVICE" \
  --region "$REGION" --project "$GCP_PROJECT_ID" \
  --member allUsers --role roles/run.invoker

SERVICE_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" \
  --project "$GCP_PROJECT_ID" --format 'value(status.url)')"

# Browsers PUT uploads and stream playback straight from GCS, so the bucket must allow the app's
# origin (and the local dev server).
cors="$(mktemp)"
trap 'rm -f "$rendered" "$cors"' EXIT
cat > "$cors" << CORS
[{"origin": ["${SERVICE_URL}", "http://localhost:5173"],
  "method": ["GET", "PUT"],
  "responseHeader": ["Content-Type", "Content-Range", "Accept-Ranges", "Range",
    "x-goog-content-length-range"],
  "maxAgeSeconds": 3600}]
CORS
gcloud storage buckets update "gs://${GCS_BUCKET}" --cors-file "$cors" \
  --project "$GCP_PROJECT_ID" --quiet > /dev/null

echo "$SEPARATOR"
echo "Deployed: $SERVICE_URL"
echo "$SEPARATOR"
