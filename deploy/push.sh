#!/usr/bin/env bash
# On the Mac: build the image and push it to the Aliyun registry.
# The server only pulls it: docker compose pull && docker compose up -d
#
# Usage: REGISTRY=registry.example.com/you ./deploy/push.sh [tag]   # tag defaults to $IMAGE_TAG or "latest"
#
# Prerequisite (once): docker login <your registry host>
set -euo pipefail

cd "$(dirname "$0")/.."   # project root

registry="${REGISTRY:?set REGISTRY, e.g. registry.example.com/you}"
tag="${1:-${IMAGE_TAG:-latest}}"
platform="${DOCKER_PLATFORM:-linux/amd64}"
image="${registry}/sub2api-guard:${tag}"

echo "==> building and pushing ${image} (${platform})"
# The Aliyun registry rejects BuildKit's provenance and SBOM attestation manifests.
docker buildx build --platform "$platform" --provenance=false --sbom=false --push -t "$image" .

echo
echo "Done. On the server (in the sub2api-guard dir, with docker-compose.yml + .env):"
echo "    docker compose pull && docker compose up -d"
