#!/usr/bin/env bash
# Two-way sync between this folder and GitHub (origin/main).
#   - Pulls remote commits (rebase, so local commits replay on top; uncommitted edits are stashed and restored).
#   - Pushes local commits.
#   - With AUTO_COMMIT=1, first commits any local changes with a timestamped message.
# Never force-pushes. On a conflict it stops, leaves the repo untouched, and exits non-zero so you can resolve it.
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="${SYNC_BRANCH:-main}"
LOG_PREFIX="[git-sync $(date '+%Y-%m-%d %H:%M:%S')]"

if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ]; then
  echo "$LOG_PREFIX a rebase/merge is in progress — resolve it first (git status)"; exit 2
fi
current=$(git rev-parse --abbrev-ref HEAD)
if [ "$current" != "$BRANCH" ]; then echo "$LOG_PREFIX on branch '$current', not '$BRANCH' — skipping"; exit 0; fi

if [ "${AUTO_COMMIT:-0}" = "1" ] && [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "sync: local changes $(date '+%Y-%m-%d %H:%M')"
  echo "$LOG_PREFIX committed local changes"
fi

git fetch -q origin "$BRANCH"
if ! git pull -q --rebase --autostash origin "$BRANCH"; then
  git rebase --abort 2>/dev/null || true
  echo "$LOG_PREFIX CONFLICT pulling origin/$BRANCH — nothing was pushed. Resolve manually: git pull --rebase origin $BRANCH"
  exit 1
fi

ahead=$(git rev-list --count "origin/$BRANCH..HEAD")
if [ "$ahead" -gt 0 ]; then
  git push -q origin "$BRANCH"
  echo "$LOG_PREFIX pushed $ahead commit(s)"
else
  echo "$LOG_PREFIX up to date"
fi
