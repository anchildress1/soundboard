#!/usr/bin/env bash
set -euo pipefail

SERVICE="soundboard"
REGION="us-central1"
APP_DOMAIN="https://soundboard.anchildress1.dev"
SEPARATOR="=================================================="

command -v gcloud > /dev/null || { echo "Error: gcloud CLI is not installed." >&2; exit 1; }
command -v envsubst > /dev/null || { echo "Error: envsubst (gettext) is not installed." >&2; exit 1; }
command -v pnpm > /dev/null || { echo "Error: pnpm is not installed." >&2; exit 1; }

# .env.sentry-build-plugin holds the Sentry source-map upload token; it's optional.
for file in .env .env.sentry-build-plugin; do
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$file"
    set +a
  fi
done

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
require_env FLR_CHANNEL_ID
require_env GOOGLE_OAUTH_CLIENT_ID
SIGNUP_MODE="${SIGNUP_MODE:-invite}"
case "$SIGNUP_MODE" in invite | open) ;; *) echo "Error: SIGNUP_MODE must be invite or open." >&2; exit 1 ;; esac
PUBLIC_SENTRY_DSN="${PUBLIC_SENTRY_DSN:-}"

KMS_KEYRING="soundboard"
KMS_KEY_NAME="refresh-tokens"
KMS_KEY="projects/${GCP_PROJECT_ID}/locations/${REGION}/keyRings/${KMS_KEYRING}/cryptoKeys/${KMS_KEY_NAME}"
export GCP_PROJECT_ID GCS_BUCKET FLR_CHANNEL_ID GOOGLE_OAUTH_CLIENT_ID SIGNUP_MODE KMS_KEY \
  PUBLIC_SENTRY_DSN
SERVICE_ACCOUNT="${SERVICE}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
GIT_SHA="$(git rev-parse --short HEAD)"
APP_IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${SERVICE}/app:${GIT_SHA}"
export SERVICE_ACCOUNT APP_IMAGE

echo "$SEPARATOR"
echo "Project: $GCP_PROJECT_ID"
echo "Region:  $REGION"
echo "App:     $APP_IMAGE"
echo "$SEPARATOR"

gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com run.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com cloudkms.googleapis.com \
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
# Storage is billed per GB: keep the 5 newest app images.
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

# YouTube refresh tokens are stored in Postgres as KMS ciphertext. Key rings and keys can't be
# deleted, so they are created once; the runtime identity may encrypt and decrypt with this key only.
if ! gcloud kms keyrings describe "$KMS_KEYRING" --location "$REGION" \
  --project "$GCP_PROJECT_ID" &> /dev/null; then
  gcloud kms keyrings create "$KMS_KEYRING" --location "$REGION" --project "$GCP_PROJECT_ID" --quiet
fi
if ! gcloud kms keys describe "$KMS_KEY_NAME" --keyring "$KMS_KEYRING" --location "$REGION" \
  --project "$GCP_PROJECT_ID" &> /dev/null; then
  gcloud kms keys create "$KMS_KEY_NAME" --keyring "$KMS_KEYRING" --location "$REGION" \
    --purpose encryption --project "$GCP_PROJECT_ID" --quiet
fi
gcloud kms keys add-iam-policy-binding "$KMS_KEY_NAME" --keyring "$KMS_KEYRING" \
  --location "$REGION" --project "$GCP_PROJECT_ID" \
  --member "serviceAccount:${SERVICE_ACCOUNT}" --role roles/cloudkms.cryptoKeyEncrypterDecrypter \
  --quiet > /dev/null

# App secrets come from .env on first deploy (or when the value changes) and live only in Secret
# Manager after that. The runtime identity reads them; it never sees them on disk.
# Third argument: who reads the secret; the runtime identity unless named.
sync_secret() {
  local secret=$1 value=${!2:-} member=${3:-serviceAccount:${SERVICE_ACCOUNT}}
  if ! gcloud secrets describe "$secret" --project "$GCP_PROJECT_ID" &> /dev/null; then
    [[ -n "$value" ]] || { echo "Error: secret '$secret' is missing; set $2 in .env." >&2; exit 1; }
    gcloud secrets create "$secret" --replication-policy automatic --project "$GCP_PROJECT_ID" --quiet
  fi
  if [[ -n "$value" ]] && [[ "$(gcloud secrets versions access latest --secret "$secret" \
    --project "$GCP_PROJECT_ID" 2> /dev/null)" != "$value" ]]; then
    printf '%s' "$value" | gcloud secrets versions add "$secret" --data-file - \
      --project "$GCP_PROJECT_ID" --quiet > /dev/null
  fi
  grant_secret "$secret" "$member"
}
grant_secret() {
  gcloud secrets add-iam-policy-binding "$1" --project "$GCP_PROJECT_ID" \
    --member "$2" --role roles/secretmanager.secretAccessor --quiet > /dev/null
}
sync_secret soundboard-session-secret SESSION_SECRET
sync_secret soundboard-oauth-client-secret GOOGLE_OAUTH_CLIENT_SECRET
sync_secret soundboard-youtube-api-key YOUTUBE_API_KEY
sync_secret soundboard-gemini-api-key GEMINI_API_KEY
# The prod database URL lives only in Secret Manager: .env's points local dev at its own Neon branch.
gcloud secrets describe DATABASE_URL --project "$GCP_PROJECT_ID" &> /dev/null || {
  echo "Error: secret 'DATABASE_URL' is missing; create it from Neon's main branch (README)." >&2
  exit 1
}
grant_secret DATABASE_URL "serviceAccount:${SERVICE_ACCOUNT}"
# The runtime cannot read the owner credential used by migrations and operator commands.
gcloud secrets describe DATABASE_URL_UNPOOLED --project "$GCP_PROJECT_ID" &> /dev/null || {
  echo "Error: secret 'DATABASE_URL_UNPOOLED' is missing; create it with the main branch's owner URL." >&2
  exit 1
}
grant_secret DATABASE_URL_UNPOOLED "${DEPLOYER_TYPE}:${DEPLOYER}"

# With a Sentry token, the build uploads source maps for this commit's release. Only Cloud Build's
# identity reads the token; the running service never sees it.
if [[ -n "${SENTRY_AUTH_TOKEN:-}" ]]; then
  BUILD_ACCOUNT="$(gcloud builds get-default-service-account --project "$GCP_PROJECT_ID" \
    --format 'value(serviceAccountEmail)')"
  sync_secret soundboard-sentry-auth-token SENTRY_AUTH_TOKEN "serviceAccount:${BUILD_ACCOUNT##*/}"
  gcloud builds submit . --config cloudbuild.yaml --project "$GCP_PROJECT_ID" \
    --substitutions "_IMAGE=${APP_IMAGE},_RELEASE=${GIT_SHA}"
else
  echo "No SENTRY_AUTH_TOKEN: building without source-map upload." >&2
  gcloud builds submit . --tag "$APP_IMAGE" --project "$GCP_PROJECT_ID"
fi

# Migrations need the owner's direct URL; the runtime credential cannot alter the schema.
# A separate assignment so set -e stops the deploy when the secret read fails.
migrate_url="$(gcloud secrets versions access latest --secret DATABASE_URL_UNPOOLED \
  --project "$GCP_PROJECT_ID")"
DATABASE_URL_UNPOOLED="$migrate_url" pnpm exec drizzle-kit migrate

rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
# Single quotes are deliberate: envsubst takes the variable list literally.
# shellcheck disable=SC2016
envsubst '${SERVICE_ACCOUNT} ${APP_IMAGE} ${GCP_PROJECT_ID} ${GCS_BUCKET}
  ${FLR_CHANNEL_ID} ${GOOGLE_OAUTH_CLIENT_ID} ${SIGNUP_MODE} ${KMS_KEY} ${PUBLIC_SENTRY_DSN}' \
  < service.yaml > "$rendered"

gcloud run services replace "$rendered" --region "$REGION" --project "$GCP_PROJECT_ID"
gcloud run services add-iam-policy-binding "$SERVICE" \
  --region "$REGION" --project "$GCP_PROJECT_ID" \
  --member allUsers --role roles/run.invoker

SERVICE_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" \
  --project "$GCP_PROJECT_ID" --format 'value(status.url)')"
# Cloud Run serves the app at more than one run.app URL; status.url names only one of them.
RUN_ORIGINS="$(gcloud run services describe "$SERVICE" --region "$REGION" \
  --project "$GCP_PROJECT_ID" --format json |
  python3 -c 'import json, sys
s = json.load(sys.stdin)
urls = json.loads(s["metadata"]["annotations"].get("run.googleapis.com/urls", "[]"))
print(", ".join(json.dumps(u) for u in urls or [s["status"]["url"]]))')"

# Browsers stream playback straight from GCS through the XML API, so the bucket must allow the
# app's origins: the custom domain, every run.app URL, and the local dev server. Uploads use JSON
# API resumable sessions, which answer CORS for any origin; bucket CORS doesn't govern them.
cors="$(mktemp)"
trap 'rm -f "$rendered" "$cors"' EXIT
cat > "$cors" << CORS
[{"origin": ["${APP_DOMAIN}", ${RUN_ORIGINS}, "http://localhost:5173"],
  "method": ["GET"],
  "responseHeader": ["Content-Type", "Content-Range", "Accept-Ranges", "Range"],
  "maxAgeSeconds": 3600}]
CORS
gcloud storage buckets update "gs://${GCS_BUCKET}" --cors-file "$cors" \
  --project "$GCP_PROJECT_ID" --quiet > /dev/null

echo "$SEPARATOR"
echo "Deployed: $SERVICE_URL"
echo "$SEPARATOR"
