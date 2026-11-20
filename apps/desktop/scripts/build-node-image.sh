#!/usr/bin/env bash
# Builds the local node agent image (spec 036 US2): sam-local-node:<tag>.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
tag="${SAM_LOCAL_NODE_IMAGE:-sam-local-node:dev}"
make -C "$repo/packages/vm-agent" build-linux-amd64
context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
cp "$repo/packages/vm-agent/bin/vm-agent-linux-amd64" "$context/vm-agent-linux-amd64"
docker build --label sam.role=node-image -f "$here/docker/local-node.Dockerfile" -t "$tag" "$context"
echo "$tag"
