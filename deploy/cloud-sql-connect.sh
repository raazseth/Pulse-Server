#!/usr/bin/env bash
# deploy/cloud-sql-connect.sh
# Opens a local tunnel to Cloud SQL via the Cloud SQL Auth Proxy.
# Useful for running migrations or inspecting the production database locally.
#
# Prerequisites:
#   cloud-sql-proxy installed:
#     https://cloud.google.com/sql/docs/postgres/connect-auth-proxy
#   gcloud CLI authenticated as a principal with Cloud SQL Client role.
#
# Usage:
#   INSTANCE_CONNECTION_NAME=project:region:instance bash deploy/cloud-sql-connect.sh
set -euo pipefail

INSTANCE="${INSTANCE_CONNECTION_NAME:?Set INSTANCE_CONNECTION_NAME (e.g. myproject:us-central1:pulse-db)}"
LOCAL_PORT="${LOCAL_PORT:-5433}"

echo "▸ Proxying ${INSTANCE} → localhost:${LOCAL_PORT}"
echo "  Connect with: psql postgresql://USER:PASS@localhost:${LOCAL_PORT}/pulse_hud"
echo "  Ctrl-C to stop."
echo ""

cloud-sql-proxy \
  "--port=${LOCAL_PORT}" \
  "${INSTANCE}"
