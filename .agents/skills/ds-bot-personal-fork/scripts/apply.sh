#!/usr/bin/env bash
# Copies the built plugin from the main checkout into the profile DSH runs, so
# the running app uses this fork. DS Bot's own update reinstalls the npm package
# and replaces these files: rerun this after every update.
#
# Usage: apply.sh [--profile <dir>]
#   --profile  the DSH profile to write into; defaults to $DSH_PROFILE_DIR,
#              else ~/.local/share/deepseek-harness/state/profiles/${DSH_PROFILE:-web}
#
# Run it from the main checkout after `git reset --hard toqoz/main`. The checkout
# must already have ds-bot/node_modules (run `npm ci` in ds-bot once).
set -euo pipefail

profile=${DSH_PROFILE_DIR:-"$HOME/.local/share/deepseek-harness/state/profiles/${DSH_PROFILE:-web}"}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      shift
      profile=${1:-}
      if [ -z "$profile" ]; then
        echo "apply.sh: --profile needs a directory" >&2
        exit 2
      fi
      ;;
    *)
      echo "apply.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

root=$(git rev-parse --show-toplevel)
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "toqoz/main" ]; then
  echo "apply.sh: the checkout is on $branch; run 'git reset --hard toqoz/main' first" >&2
  exit 1
fi

src="$root/ds-bot"
dst="$profile/node_modules/ds-bot"
if [ ! -d "$dst" ]; then
  echo "apply.sh: no installed ds-bot in $profile/node_modules" >&2
  exit 1
fi
if [ ! -f "$src/client.js" ]; then
  echo "apply.sh: $src/client.js is missing; run the sync script" >&2
  exit 1
fi
node "$src/scripts/build-client.mjs" --check

# package.json and the lock stay the profile's: pnpm installed this package and
# its version string is what the update check compares against.
rsync -a --delete \
  --exclude node_modules --exclude test --exclude dev --exclude scripts \
  --exclude package-lock.json --exclude package.json \
  "$src/" "$dst/"

version=$(node -p "require('$dst/package.json').version" 2>/dev/null || echo '?')
echo "applied toqoz/main (ds-bot $version) into $dst"
echo "reload the DSH page to pick it up; rerun this after a DS Bot update"
