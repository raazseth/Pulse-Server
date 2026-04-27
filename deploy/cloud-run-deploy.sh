#!/usr/bin/env bash
# deploy/cloud-run-deploy.sh
# Manual one-shot deploy to GCP Cloud Run.
# Usage: bash deploy/cloud-run-deploy.sh
#
# Prerequisites:
#   gcloud CLI authenticated:  gcloud auth login && gcloud auth configure-docker
#   Artifact Registry repo created (see README.md § GCP setup)
#   Secrets stored in Secret Manager (see README.md § Secrets)
set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-us-central1}"
AR_REPO="${AR_REPO:-pulse-hud}"
SERVICE_NAME="${CLOUD_RUN_SERVICE:-pulse-hud-server}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/server"
TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"

echo "▸ Project  : ${PROJECT_ID}"
echo "▸ Region   : ${REGION}"
echo "▸ Service  : ${SERVICE_NAME}"
echo "▸ Image    : ${IMAGE}:${TAG}"
echo ""

# ── Build & push ──────────────────────────────────────────────────────────────
echo "── Building Docker image ────────────────────────────────────────────────"
docker build \
  --tag "${IMAGE}:${TAG}" \
  --tag "${IMAGE}:latest" \
  "$(dirname "$0")/.."

echo "── Pushing to Artifact Registry ─────────────────────────────────────────"
docker push "${IMAGE}:${TAG}"
docker push "${IMAGE}:latest"

# ── Deploy ────────────────────────────────────────────────────────────────────
echo "── Deploying to Cloud Run ───────────────────────────────────────────────"
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}:${TAG}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10 \
  --timeout 300 \
  --set-env-vars "NODE_ENV=production" \
  --set-secrets "DATABASE_URL=PULSE_DATABASE_URL:latest,JWT_SECRET=PULSE_JWT_SECRET:latest,JWT_REFRESH_SECRET=PULSE_JWT_REFRESH_SECRET:latest" \
  --quiet

echo ""
URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${REGION}" \
  --format "value(status.url)")
echo "✓ Live at: ${URL}"
echo "  Health:  ${URL}/api/v1/health"
