#!/usr/bin/env bash
# Deploy the extension to the live pi extensions directory for local testing.
#
# Builds the flat layout via build-dist.mjs (packages/extension at root,
# components vendored), then npm installs. No version bump, no tag, no
# release branch needed. The deployed dir is NOT a git worktree — it's a
# pure deployment target. A .deployed-from file records the source commit
# so you can tell what's running without git.
#
# Usage:
#   scripts/deploy-local.sh                # deploy current working tree
#   scripts/deploy-local.sh <commit>       # deploy a specific commit
#
# Prerequisites:
#   - Run from the dev repo root (~/Workdir/pi-webui-monorepo)
#   - Clean working tree (the script checks; stash or commit first)
#   - No live session is mid-turn on the extension (the reload will pick
#     up the new files on the next /reload or session restart)

set -euo pipefail

DEV_REPO="$(git rev-parse --show-toplevel)"
DEPLOY_DIR="${PI_DEPLOY_DIR:-$HOME/.pi/agent/extensions/pi-webui-extension}"
VERSION="0.0.0-local"

# Resolve a commit argument, or default to the current working-tree state.
if [[ $# -ge 1 ]]; then
  COMMIT="$1"
  git rev-parse --verify "$COMMIT^{commit}" >/dev/null
else
  COMMIT="HEAD"
fi

# Refuse to deploy with a dirty tree (build-dist reads the working tree,
# not HEAD, so uncommitted changes would silently ship).
if [[ -n $(git status --porcelain -- packages/ biome.json) ]]; then
  echo "deploy-local: working tree has uncommitted changes under packages/ or biome.json" >&2
  echo "  commit or stash first, then re-run" >&2
  exit 1
fi

# build-dist.mjs reads the working tree, so if a commit arg was given we
# need to check it out. We restore the original branch on exit.
ORIG_HEAD=""
if [[ $# -ge 1 ]]; then
  ORIG_HEAD=$(git rev-parse --abbrev-ref HEAD)
  if [[ "$ORIG_HEAD" == "HEAD" ]]; then
    ORIG_HEAD=$(git rev-parse HEAD)
  fi
  echo "deploy-local: checking out $COMMIT (will restore $ORIG_HEAD after)"
  git checkout --quiet "$COMMIT"
  trap 'git checkout --quiet "$ORIG_HEAD"' EXIT
fi

echo "deploy-local: building flat layout ($COMMIT) → $DEPLOY_DIR"
node "$DEV_REPO/scripts/build-dist.mjs" "$VERSION" "$DEPLOY_DIR"

# Record what we deployed from (build-dist runs from the working tree, so
# this is the actual commit the files came from).
git rev-parse HEAD > "$DEPLOY_DIR/.deployed-from"
echo "deploy-local: wrote .deployed-from = $(cat "$DEPLOY_DIR/.deployed-from")"

echo "deploy-local: npm install"
( cd "$DEPLOY_DIR" && npm install )

echo "deploy-local: done"
echo "  reload the session (⟳ / /reload) to pick up the new extension"
