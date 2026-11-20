# Local node agent image for the SAM desktop app (spec 036 US2).
# Runs the Go VM Agent in node mode inside Docker Desktop's WSL2 VM. It drives the host
# Docker Engine through the mounted socket; the Docker API is never published.
# Build: pnpm --filter @simple-agent-manager/desktop build:node-image
FROM docker.io/library/node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends bash ca-certificates curl git jq openssh-client procps gnupg; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin; \
    npm install -g @devcontainers/cli@0.80.3; \
    npm cache clean --force; \
    rm -rf /var/lib/apt/lists/*

COPY vm-agent-linux-amd64 /usr/local/bin/vm-agent

ENV VM_AGENT_HOST=0.0.0.0 \
    VM_AGENT_PORT=8443 \
    VM_AGENT_PROTOCOL=http \
    PERSISTENCE_DB_PATH=/var/lib/vm-agent/state.db \
    EVENTSTORE_DB_PATH=/var/lib/vm-agent/events.db \
    METRICS_DB_PATH=/var/lib/vm-agent/metrics.db \
    BOOTSTRAP_STATE_PATH=/var/lib/vm-agent/bootstrap-state.json

VOLUME /var/lib/vm-agent
EXPOSE 8443
ENTRYPOINT ["/usr/local/bin/vm-agent"]
