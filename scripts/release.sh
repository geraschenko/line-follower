#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release.sh (or: npm run release)

Runs presubmit, shows the packaged file list, then publishes to npm and
pushes the release tag (created by `npm version`).
USAGE
}

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")

# npm pack/publish take files from the working tree, not from git, so an
# unclean tree could publish unreviewed state.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is not clean; commit or stash before releasing" >&2
  exit 1
fi

# The registry would reject a duplicate version anyway, but only after the
# checks below have run, so fail early. `npm view` exits nonzero when the
# version (or the whole package) does not exist; both mean it is publishable.
if npm view "$NAME@$VERSION" version >/dev/null 2>&1; then
  echo "version $VERSION is already published; bump package.json first" >&2
  exit 1
fi

run npm run presubmit

printf '\n==> npm pack --dry-run\n'
npm pack --dry-run

printf '\nPublish %s %s with the packaged files listed above? [y/N] ' "$NAME" "$VERSION"
read -r answer
case "$answer" in
  y|Y|yes|YES)
    ;;
  *)
    echo "aborting release"
    exit 1
    ;;
esac

run npm publish
run git push origin
run git push origin "v$VERSION"
