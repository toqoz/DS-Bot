#!/usr/bin/env bash
# Personal-fork operations for toqoz/DS-Bot: rebase every change branch onto
# upstream, rebuild the integration branch as one commit, regenerate the client
# bundle, and publish. See ../SKILL.md.
#
# Usage: sync.sh [--message <gist-url>] [--push]
#   --message  gist URL for the rebuilt integration commit; defaults to the
#              branch's current subject, which is the gist URL of the previous
#              run
#   --push     publish every change branch and the integration branch
#
# Runs from any worktree and never moves the caller's checkout: change branches
# are rebased in temporary worktrees and the integration branch is moved with
# `git update-ref`. The running worktree keeps its old files until it is reset.
#
# `ds-bot/client.js` is generated from `ds-bot/src/client`, so every rewritten
# branch is rebuilt here and its commit amended. The build needs esbuild from
# the main checkout's `ds-bot/node_modules` (run `npm ci` there once).
set -euo pipefail

UPSTREAM_REMOTE=upstream
UPSTREAM_BRANCH=main
UPSTREAM_REF="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
INTEGRATION_BRANCH=toqoz/main
CHANGE_PREFIX=toqoz/feat/
push=false
message=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --push) push=true ;;
    --message)
      shift
      message=${1:-}
      if [ -z "$message" ]; then
        echo "sync.sh: --message needs a gist URL" >&2
        exit 2
      fi
      ;;
    *)
      echo "sync.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "sync.sh: working tree is not clean; commit or stash first" >&2
  exit 1
fi

if [ -z "$message" ]; then
  message=$(git log -1 --format=%s "$INTEGRATION_BRANCH" 2>/dev/null || true)
fi
case "$message" in
  https://gist.github.com/*) ;;
  *)
    echo "sync.sh: $INTEGRATION_BRANCH has no gist URL; pass --message <url>" >&2
    exit 1
    ;;
esac

common=$(git rev-parse --path-format=absolute --git-common-dir)
modules="$(dirname "$common")/ds-bot/node_modules"
if [ ! -d "$modules/esbuild" ]; then
  echo "sync.sh: no esbuild in $modules; run 'npm ci' in ds-bot once" >&2
  exit 1
fi

tmp_root="$common/wt"
worktrees=()
keep_worktrees=false
cleanup() {
  [ "$keep_worktrees" = true ] && return
  for path in ${worktrees[@]+"${worktrees[@]}"}; do
    git worktree remove --force "$path" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# Regenerate the committed bundle from the branch's own sources, so a rewritten
# branch never ships a client.js built from another base.
rebuild_client() {
  local path=$1
  ln -sfn "$modules" "$path/ds-bot/node_modules"
  node "$path/ds-bot/scripts/build-client.mjs"
  node "$path/ds-bot/scripts/build-client.mjs" --check
  git -C "$path" add ds-bot/client.js
}

echo "fetching $UPSTREAM_REMOTE $UPSTREAM_BRANCH"
git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" --prune
git rev-parse --verify "$UPSTREAM_REF" >/dev/null

changes=()
while IFS= read -r branch; do
  changes+=("$branch")
done < <(git for-each-ref --format='%(refname:short)' "refs/heads/$CHANGE_PREFIX")

if [ "${#changes[@]}" -eq 0 ]; then
  echo "sync.sh: no ${CHANGE_PREFIX}* branches" >&2
  exit 1
fi

# A squashed branch tip whose subject is one bare gist URL is an integration
# commit, never a personal change.
is_integration_commit() {
  case "$(git log -1 --format=%s "$1")" in
    https://gist.github.com/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Each change is one commit. Checking before the rebase names the offending
# branch before history is rewritten under it.
bases=()
stale_counts=()
for branch in "${changes[@]}"; do
  own=0
  base=
  stale=0
  while IFS= read -r commit; do
    if [ "$own" -eq 0 ] && is_integration_commit "$commit"; then
      stale=$((stale + 1))
      continue
    fi
    own=$((own + 1))
    base=$(git rev-parse "$commit~1")
  done < <(git rev-list --reverse "$UPSTREAM_REF..$branch")
  if [ "$own" -ne 1 ]; then
    echo "sync.sh: $branch holds $own personal commits on $UPSTREAM_REF; a change holds exactly one" >&2
    exit 1
  fi
  if [ -n "$(git rev-list --merges "$base..$branch")" ]; then
    echo "sync.sh: $branch contains a merge commit; a change holds one non-merge commit" >&2
    exit 1
  fi
  bases+=("$base")
  stale_counts+=("$stale")
done

index=0
for branch in "${changes[@]}"; do
  base=${bases[$index]}
  stale=${stale_counts[$index]}
  index=$((index + 1))
  if [ "$stale" -gt 0 ]; then
    echo "rebasing $branch onto $UPSTREAM_REF, dropping $stale stale upstream commit(s)"
  else
    echo "rebasing $branch onto $UPSTREAM_REF"
  fi
  path="$tmp_root/rebase-$(printf '%s' "$branch" | tr '/' '-')"
  worktrees+=("$path")
  # The branch is checked out here, so `git rebase --continue` moves it for us.
  git worktree add --force "$path" "$branch" >/dev/null
  if ! git -C "$path" rebase --onto "$UPSTREAM_REF" "$base"; then
    keep_worktrees=true
    echo "sync.sh: $branch conflicts; resolve it in $path, run 'git -C $path rebase --continue', then remove that worktree and rerun" >&2
    exit 1
  fi
  commits=$(git -C "$path" rev-list --count "$UPSTREAM_REF..HEAD")
  if [ "$commits" -ne 1 ]; then
    echo "sync.sh: rebasing $branch left $commits commits; upstream may already contain it — delete the branch and rerun" >&2
    exit 1
  fi
  rebuild_client "$path"
  if ! git -C "$path" diff --cached --quiet; then
    git -C "$path" commit --no-verify --amend --no-edit -q
  fi
  git worktree remove --force "$path"
done

echo "rebuilding $INTEGRATION_BRANCH from $UPSTREAM_REF"
build_path="$tmp_root/build"
worktrees+=("$build_path")
git worktree add --force --detach "$build_path" "$UPSTREAM_REF" >/dev/null
for branch in "${changes[@]}"; do
  if ! git -C "$build_path" merge --squash "$branch" >/dev/null; then
    echo "sync.sh: merging $branch into $INTEGRATION_BRANCH conflicted; the rebuild was discarded." >&2
    echo "sync.sh: resolve the overlap in $branch, or move the shared part into its own branch, then rerun." >&2
    exit 1
  fi
  git -C "$build_path" commit --no-verify -q -m "squash $branch"
done
git -C "$build_path" reset --soft "$UPSTREAM_REF"
rebuild_client "$build_path"
git -C "$build_path" add -A
git -C "$build_path" commit --no-verify -q -m "$message"
new_commit=$(git -C "$build_path" rev-parse HEAD)
new_tree=$(git -C "$build_path" rev-parse 'HEAD^{tree}')
current_tree=$(git rev-parse --verify "refs/heads/$INTEGRATION_BRANCH^{tree}" 2>/dev/null || true)
if [ "$new_tree" = "$current_tree" ] && [ "$message" = "$(git log -1 --format=%s "$INTEGRATION_BRANCH" 2>/dev/null || true)" ]; then
  echo "$INTEGRATION_BRANCH already matches upstream and every change; nothing to rebuild"
  git worktree remove --force "$build_path"
  exit 0
fi
old_commit=$(git rev-parse --verify "refs/heads/$INTEGRATION_BRANCH" 2>/dev/null || true)
if [ -n "$old_commit" ]; then
  git update-ref "refs/heads/$INTEGRATION_BRANCH" "$new_commit" "$old_commit"
else
  git update-ref "refs/heads/$INTEGRATION_BRANCH" "$new_commit"
fi
git worktree remove --force "$build_path"

commits=$(git rev-list --count "$UPSTREAM_REF..$INTEGRATION_BRANCH")
if [ "$commits" -ne 1 ]; then
  echo "sync.sh: $INTEGRATION_BRANCH has $commits commits on $UPSTREAM_REF; expected one" >&2
  exit 1
fi

echo
echo "$INTEGRATION_BRANCH: $(git log -1 --format=%s "$INTEGRATION_BRANCH")"
git diff --stat "$UPSTREAM_REF..$INTEGRATION_BRANCH" | tail -1
echo "the checked-out worktree keeps its old files until 'git reset --hard $INTEGRATION_BRANCH'"

if [ "$push" = true ]; then
  for branch in "${changes[@]}"; do
    echo "pushing $branch"
    git push --no-verify --force-with-lease --set-upstream origin "$branch"
  done
  echo "pushing $INTEGRATION_BRANCH"
  git push --no-verify --force-with-lease origin "$INTEGRATION_BRANCH"
fi
