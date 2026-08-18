#!/usr/bin/env bash
set -euo pipefail

readonly repository="${1:?usage: tracked-manifest.sh <repository>}"

# Git emits the root index and initialized submodule indexes as one NUL-safe,
# deterministic path manifest. Consumers must use --null when reading it.
git -C "$repository" ls-files --cached --recurse-submodules -z
