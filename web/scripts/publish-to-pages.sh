#!/usr/bin/env bash
#
# Publishes web/dist to the root of this repository, which is what GitHub Pages
# serves for https://mdraficode.github.io/rafzzermes-web-app/ (Pages source:
# "deploy from a branch", branch gh-pages, path /).
#
# Equivalent to the deploy-web.yml workflow, for running by hand.
#
#   ./web/scripts/publish-to-pages.sh          # build, then stage + commit
#   ./web/scripts/publish-to-pages.sh --no-commit
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

COMMIT=1
[[ "${1:-}" == "--no-commit" ]] && COMMIT=0

echo "==> Building web app (base=/rafzzermes-web-app/)"
(cd web && VITE_BASE=/rafzzermes-web-app/ npm run build)

echo "==> Copying build output to the repository root"
rm -rf assets
cp -R web/dist/assets assets
cp web/dist/index.html index.html
cp web/dist/favicon.svg favicon.svg
# Stop GitHub Pages from running the output through Jekyll.
touch .nojekyll

if [[ $COMMIT -eq 0 ]]; then
  echo "==> Staged (--no-commit); review with: git status"
  exit 0
fi

git add -A index.html favicon.svg assets .nojekyll
if git diff --cached --quiet; then
  echo "==> Build output unchanged — nothing to commit"
  exit 0
fi

git commit -m "Publish Rafzzermes Web App build"
echo "==> Committed. Push to gh-pages (or merge a PR into it) to go live."
