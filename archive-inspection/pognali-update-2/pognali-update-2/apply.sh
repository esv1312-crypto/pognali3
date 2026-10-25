#!/bin/sh
# Run from the repo root on a clean branch based on commit a37ea03 (or later with the same code).
set -e
for p in "$(dirname "$0")"/1*.patch; do
  echo "applying $(basename "$p")"
  git apply "$p"
done
npm install
npm test
echo "done: everything applied and all tests pass; review with 'git diff', then commit"
