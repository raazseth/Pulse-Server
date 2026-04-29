FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY types.d.ts ./

RUN npm run build

FROM node:22-slim AS production
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY scripts/ ./scripts/

RUN mkdir -p /app/models && chown -R node:node /app/models

USER node

ARG WHISPER_MODEL=base.en
ENV WHISPER_MODEL=${WHISPER_MODEL} \
    WHISPER_MODELS_DIR=/app/models

RUN node scripts/warmup.js || echo "⚠ Whisper model warmup skipped — will download at first startup"

EXPOSE 8080

CMD ["npm", "start"]
