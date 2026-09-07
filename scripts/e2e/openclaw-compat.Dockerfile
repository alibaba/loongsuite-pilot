FROM node:22-bookworm
ARG OPENCLAW_VERSION=2026.3.8
RUN npm install --prefix /opt/openclaw openclaw@${OPENCLAW_VERSION} --no-audit --no-fund
WORKDIR /candidate
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm rebuild && npm run build
# Newer OpenClaw postinstall creates disposable state; preserve it outside the
# runtime HOME so the acceptance starts with a genuinely fresh configuration.
RUN if [ -d /root/.openclaw ]; then mv /root/.openclaw /opt/openclaw-build-state; fi
ENV OPENCLAW_E2E_DISPOSABLE=1 OPENCLAW_E2E_INSTALL=/opt/openclaw
ENV OPENCLAW_E2E_VERSION=${OPENCLAW_VERSION}
CMD ["node", "scripts/e2e/openclaw-compat.mjs"]
