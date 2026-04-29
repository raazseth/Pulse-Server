# Pulse HUD — Server

Express + Node.js backend for the Pulse HUD real-time interview system.
REST API + WebSocket, Postgres storage, JWT auth, OpenAI (ChatGPT API) as the primary suggestion model with Gemini as an optional fallback when no OpenAI key is set.

---

## Table of Contents

1. [Local development](#1-local-development)
2. [Environment variables](#2-environment-variables)
3. [Running with Docker (local)](#3-running-with-docker-local)
4. [GCP Cloud Run deployment](#4-gcp-cloud-run-deployment)
5. [CI/CD — GitHub Actions](#5-cicd--github-actions)
6. [API reference](#6-api-reference)

---

## 1. Local development

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 22 LTS |
| npm | 10+ |
| PostgreSQL | 14+ |

### Setup

```bash
cd server

# 1. Install dependencies
npm install

# 2. Copy the example env file and fill in your values
cp .env.example .env.development

# 3. Create the local database
createdb pulse_hud

# 4. Start the dev server (ts-node + nodemon, auto-restarts on save)
npm run dev
```

The server starts on **http://localhost:3000** by default.
Health check: `GET /api/v1/health`

### Running tests

```bash
# Set TEST_DATABASE_URL to a separate test database to avoid wiping dev data
createdb pulse_hud_test
export TEST_DATABASE_URL=postgresql://user:password@localhost:5432/pulse_hud_test

npm test              # single run
npm run test:watch    # watch mode
npm run test:coverage # coverage report
```

---

## 2. Environment variables

Copy `.env.example` to the appropriate file (`.env.development`, `.env.production`, `.env.local`) and fill in your values.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | HTTP port the server listens on |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string |
| `JWT_SECRET` | **Yes (prod)** | dev fallback | Secret for signing access tokens |
| `JWT_REFRESH_SECRET` | **Yes (prod)** | dev fallback | Secret for signing refresh tokens |
| `AI_PROVIDER` | No | auto-detect | `openai` (error if key missing) or `gemini` (only when `OPENAI_API_KEY` is unset). If `OPENAI_API_KEY` is set, OpenAI is always used for suggestions. |
| `OPENAI_API_KEY` | No | — | Primary: OpenAI Chat Completions for HUD prompt suggestions |
| `OPENAI_MODEL` | No | `gpt-4o-mini` | Chat Completions model id (e.g. `gpt-4o`, `gpt-4o-mini`) |
| `GEMINI_API_KEY` | No | — | Used for suggestions only when `OPENAI_API_KEY` is not set (or unset `OPENAI_API_KEY` and set `AI_PROVIDER=gemini`) |
| `ALLOWED_ORIGINS` | No | localhost dev URLs | Comma-separated browser origins allowed to call the API (include every production / custom Vercel hostname) |
| `CORS_VERCEL_TEAM_SUFFIX` | No | — | Vercel team slug (e.g. `rajs-projects-ab8ef4bc`). Allows `https://*-TEAM.vercel.app` previews without listing each deploy URL |
| `HUD_WS_PATH` | No | `/ws/transcript` | WebSocket upgrade path |
| `NODE_ENV` | No | `development` | `development` / `test` / `production` |

**Generating secure JWT secrets:**
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## 3. Running with Docker (local)

```bash
# From the server/ directory

# Build the image
docker build -t pulse-hud-server .

# Run with env vars inline
docker run \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgresql://user:pass@host.docker.internal:5432/pulse_hud" \
  -e JWT_SECRET="your-secret-here" \
  -e JWT_REFRESH_SECRET="your-refresh-secret-here" \
  pulse-hud-server
```

Or use **Docker Compose** for the full local stack (server + Postgres):

```yaml
# docker-compose.yml (create in server/ or project root)
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: pulse_hud
      POSTGRES_USER: pulse
      POSTGRES_PASSWORD: pulse
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  server:
    build: ./server
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://pulse:pulse@postgres:5432/pulse_hud
      JWT_SECRET: change-me
      JWT_REFRESH_SECRET: change-me-too
    depends_on:
      postgres:
        condition: service_started

volumes:
  pgdata:
```

```bash
docker compose up
```

---

## 4. GCP Cloud Run deployment

### 4a. One-time GCP setup

Run these once per GCP project. Replace `PROJECT_ID`, `REGION`, and `DB_INSTANCE` with your values.

```bash
export PROJECT_ID=my-gcp-project
export REGION=us-central1
export DB_INSTANCE=pulse-db   # Cloud SQL instance name

# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  --project "$PROJECT_ID"

# Create Artifact Registry repository
gcloud artifacts repositories create pulse-hud \
  --repository-format docker \
  --location "$REGION" \
  --project "$PROJECT_ID"

# Create Cloud SQL (PostgreSQL 16) instance
# This takes a few minutes
gcloud sql instances create "$DB_INSTANCE" \
  --database-version POSTGRES_16 \
  --tier db-f1-micro \
  --region "$REGION" \
  --project "$PROJECT_ID"

# Create database and user
gcloud sql databases create pulse_hud --instance "$DB_INSTANCE" --project "$PROJECT_ID"
gcloud sql users create pulse \
  --instance "$DB_INSTANCE" \
  --password "$(openssl rand -base64 24)" \
  --project "$PROJECT_ID"
```

### 4b. Store secrets in Secret Manager

```bash
# DATABASE_URL — use the Cloud SQL Unix socket format for Cloud Run
echo -n "postgresql://pulse:YOUR_DB_PASS@/pulse_hud?host=/cloudsql/${PROJECT_ID}:${REGION}:${DB_INSTANCE}" \
  | gcloud secrets create PULSE_DATABASE_URL --data-file=- --project "$PROJECT_ID"

# JWT secrets (generate fresh values)
echo -n "$(node -e "process.stdout.write(require('crypto').randomBytes(64).toString('hex'))")" \
  | gcloud secrets create PULSE_JWT_SECRET --data-file=- --project "$PROJECT_ID"

echo -n "$(node -e "process.stdout.write(require('crypto').randomBytes(64).toString('hex'))")" \
  | gcloud secrets create PULSE_JWT_REFRESH_SECRET --data-file=- --project "$PROJECT_ID"

# Optional AI keys
echo -n "sk-..." | gcloud secrets create PULSE_OPENAI_API_KEY --data-file=- --project "$PROJECT_ID"
```

### 4c. Grant the Cloud Run service account access to secrets

```bash
SA="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

for SECRET in PULSE_DATABASE_URL PULSE_JWT_SECRET PULSE_JWT_REFRESH_SECRET PULSE_OPENAI_API_KEY; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member "serviceAccount:${SA}" \
    --role roles/secretmanager.secretAccessor \
    --project "$PROJECT_ID"
done

# Also grant Cloud SQL access
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SA}" \
  --role roles/cloudsql.client
```

### 4d. Deploy manually

```bash
# From the server/ directory
export GCP_PROJECT_ID="$PROJECT_ID"
export GCP_REGION="$REGION"
bash deploy/cloud-run-deploy.sh
```

### 4e. Verify

```bash
URL=$(gcloud run services describe pulse-hud-server \
  --region "$REGION" --format "value(status.url)" --project "$PROJECT_ID")

curl "$URL/api/v1/health"
# → { "success": true, "data": { "status": "up", ... } }
```

### Cloud SQL proxy (local → production DB)

To connect to the production database from your laptop (for migrations, debugging):

```bash
# Install proxy: https://cloud.google.com/sql/docs/postgres/connect-auth-proxy
INSTANCE_CONNECTION_NAME="${PROJECT_ID}:${REGION}:${DB_INSTANCE}" \
  bash deploy/cloud-sql-connect.sh
# Then in another terminal:
# psql postgresql://pulse:PASSWORD@localhost:5433/pulse_hud
```

---

## 5. CI/CD — GitHub Actions

The workflow lives at `.github/workflows/server-ci.yml`. It runs on every push/PR that touches `server/`.

### What it does

| Trigger | Jobs |
|---------|------|
| Pull request to `main` | `test` (typecheck + tests + build) |
| Push to `main` | `test` → `deploy` (Cloud Run) |

### Required GitHub secrets and variables

Go to **Settings → Secrets and variables → Actions** in your GitHub repository.

**Secrets** (sensitive values):

| Name | Description |
|------|-------------|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity Federation provider resource name |
| `GCP_SERVICE_ACCOUNT` | `deploy@PROJECT_ID.iam.gserviceaccount.com` |

**Variables** (non-sensitive):

| Name | Example | Description |
|------|---------|-------------|
| `GCP_PROJECT_ID` | `my-gcp-project` | GCP project ID |
| `GCP_REGION` | `us-central1` | Cloud Run / Artifact Registry region |
| `AR_REPO` | `pulse-hud` | Artifact Registry repository name |
| `CLOUD_RUN_SERVICE` | `pulse-hud-server` | Cloud Run service name |

### Setting up Workload Identity Federation (keyless auth)

This avoids storing long-lived GCP service account JSON keys in GitHub.

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
POOL_ID=github-pool
PROVIDER_ID=github-provider
REPO=your-org/your-repo   # e.g. acme/pulse

# Create Workload Identity pool
gcloud iam workload-identity-pools create "$POOL_ID" \
  --location global \
  --project "$PROJECT_ID"

# Create OIDC provider for GitHub
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
  --location global \
  --workload-identity-pool "$POOL_ID" \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --project "$PROJECT_ID"

# Create deploy service account
gcloud iam service-accounts create deploy \
  --display-name "CI/CD deploy" \
  --project "$PROJECT_ID"

SA_EMAIL="deploy@${PROJECT_ID}.iam.gserviceaccount.com"

# Grant Cloud Run deploy + Artifact Registry write permissions
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SA_EMAIL}" \
  --role roles/run.admin
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SA_EMAIL}" \
  --role roles/artifactregistry.writer
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SA_EMAIL}" \
  --role roles/iam.serviceAccountUser

# Allow GitHub Actions to impersonate the service account
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${REPO}" \
  --project "$PROJECT_ID"

# Print the values to paste into GitHub secrets
echo "GCP_WORKLOAD_IDENTITY_PROVIDER:"
echo "  projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
echo "GCP_SERVICE_ACCOUNT:"
echo "  ${SA_EMAIL}"
```

---

## 6. API reference

Base URL: `/api/v1`

All protected endpoints require `Authorization: Bearer <access_token>`.

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/register` | No | Register a new user |
| `POST` | `/auth/login` | No | Login, returns token pair |
| `POST` | `/auth/refresh` | No | Rotate refresh token |
| `DELETE` | `/auth/logout` | No | Revoke refresh token |
| `GET` | `/auth/me` | Yes | Return current user |

### HUD sessions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/hud/sessions/:id` | Yes | Get full session snapshot |
| `PATCH` | `/hud/sessions/:id/context` | Yes | Update session context metadata |
| `POST` | `/hud/sessions/:id/transcript` | Yes | Submit a transcript chunk |
| `POST` | `/hud/sessions/:id/tags` | Yes | Create a tag |
| `GET` | `/hud/sessions/:id/export?format=json\|csv` | Yes | Export session |

### Audio

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/hud/audio/transcribe?lang=en` | No | Transcribe audio via Whisper |

Body: raw audio bytes (`Content-Type: audio/webm` or `audio/ogg`).
Requires `OPENAI_API_KEY`. Returns `503` if key is absent.

### WebSocket

Connect to `ws://host/ws/transcript` (path configurable via `HUD_WS_PATH`).

**Client → Server messages:**

```jsonc
{ "type": "session:subscribe", "payload": { "sessionId": "..." } }
{ "type": "transcript:chunk",  "payload": { "sessionId": "...", "text": "...", "speakerId": "..." } }
{ "type": "tag:create",        "payload": { "sessionId": "...", "label": "..." } }
{ "type": "session:context",   "payload": { "sessionId": "...", "context": { "role": "..." } } }
```

**Server → Client messages:**

```jsonc
{ "type": "connection:ready" }
{ "type": "session:state",     "payload": SessionSnapshot }
{ "type": "transcript:chunk",  "payload": TranscriptEntry }
{ "type": "prompt:update",     "payload": PromptSuggestion[] }
{ "type": "signal:detected",   "payload": SignalCue[] }
{ "type": "tag:created",       "payload": SessionTag }
{ "type": "error",             "payload": { "message": "..." } }
```

### Health

```
GET /api/v1/health  →  200 { status: "up", uptimeSeconds, memory, ... }
```
