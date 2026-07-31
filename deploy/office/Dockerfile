FROM node:22.20.0-bookworm-slim AS node-runtime

FROM python:3.12.11-slim-bookworm

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules

RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && python -m pip install --no-cache-dir uv==0.8.22

WORKDIR /app
COPY . /app

RUN npm ci \
  && uv sync --project runtimes/agently-worker --frozen --no-dev \
  && mkdir -p /app/var

ENV NODE_ENV=production \
  PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1 \
  WORK_FABRIC_LISTEN_HOST=0.0.0.0 \
  WORK_FABRIC_CONFIG=/app/examples/config/local-feishu-assistant.bundle.yaml \
  WORK_FABRIC_ENV_FILE=/run/secrets/work-fabric.env

EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["npm", "run", "local:feishu:start"]
