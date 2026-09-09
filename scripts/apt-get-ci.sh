#!/usr/bin/env bash
# CI only needs Ubuntu packages. Unrelated Chrome/Microsoft repository outages
# must not prevent installing CUPS or MinGW. Developer machines keep their sources.
set -euo pipefail

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  ubuntu_sources=/etc/apt/sources.list.d/ubuntu.sources
  if [ ! -f "$ubuntu_sources" ]; then
    echo "ERROR: expected Ubuntu 24.04 sources at $ubuntu_sources" >&2
    exit 1
  fi
  exec sudo env DEBIAN_FRONTEND=noninteractive apt-get \
    -o "Dir::Etc::sourcelist=$ubuntu_sources" \
    -o "Dir::Etc::sourceparts=-" "$@"
fi

exec sudo env DEBIAN_FRONTEND=noninteractive apt-get "$@"
