#!/usr/bin/env bash
# Copies the built plugin from the main checkout into the profile DSH runs, so
# the running app uses this fork. DS Bot's own update reinstalls the npm package
# and replaces these files: rerun this after every update.
#
# Usage: apply.sh [--profile <dir>] [--no-upgrade]
#   --profile     the DSH profile to write into; defaults to $DSH_PROFILE_DIR,
#                 else ~/.local/share/deepseek-harness/state/profiles/${DSH_PROFILE:-web}
#   --no-upgrade  stop when the profile holds another release instead of
#                 installing the one this checkout is based on
#
# An upstream import moves between releases, so the profile still holds the
# previous npm release. apply.sh then installs the release this checkout is based
# on into the profile before copying its files, which keeps one run of the
# import self-contained. Set PNPM_STORE_DIR to keep pnpm's store somewhere other
# than its default.
#
# Run it from the main checkout after `git reset --hard toqoz/main`. The checkout
# must already have ds-bot/node_modules (run `npm ci` in ds-bot once).
set -euo pipefail

profile=${DSH_PROFILE_DIR:-"$HOME/.local/share/deepseek-harness/state/profiles/${DSH_PROFILE:-web}"}
upgrade=yes

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
    --no-upgrade) upgrade=no ;;
    *)
      echo "apply.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

store_args=()
if [ -n "${PNPM_STORE_DIR:-}" ]; then store_args=(--store-dir "$PNPM_STORE_DIR"); fi

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

# The fork's files must land on the release it is based on: the profile's
# package.json version is what the plugin reports and the update check compares
# against, so a checkout built on another release installs it first.
fork_version=$(node -p "require('$src/package.json').version")
installed_version=$(node -p "require('$dst/package.json').version" 2>/dev/null || echo '?')
if [ "$fork_version" != "$installed_version" ]; then
  if [ "$upgrade" = no ]; then
    echo "apply.sh: the profile holds ds-bot $installed_version, this checkout is $fork_version" >&2
    echo "apply.sh: install ds-bot@$fork_version in the profile first, then rerun" >&2
    exit 1
  fi
  echo "apply.sh: the profile holds ds-bot $installed_version; installing $fork_version" >&2
  ( cd "$profile" && pnpm add "ds-bot@$fork_version" "${store_args[@]}" ) >&2
  installed_version=$(node -p "require('$dst/package.json').version" 2>/dev/null || echo '?')
  if [ "$fork_version" != "$installed_version" ]; then
    echo "apply.sh: the profile holds ds-bot $installed_version after installing $fork_version" >&2
    exit 1
  fi
  echo "apply.sh: upgraded the profile to ds-bot $fork_version; restart DSH to load it" >&2
fi

# package.json and the lock stay the profile's: pnpm installed this package and
# its version string is what the update check compares against.
rsync -a --delete \
  --exclude node_modules --exclude test --exclude dev --exclude scripts \
  --exclude package-lock.json --exclude package.json \
  "$src/" "$dst/"

# The fork can depend on packages the release does not carry, since its own
# features add them, while the profile keeps the release's package.json.
# Install whatever the checkout declares and that package lacks, so the plugin's
# imports resolve after the overlay.
missing=$(node -e '
  const want = require(process.argv[1]).dependencies ?? {}
  let have = {}
  try { have = require(process.argv[2]).dependencies ?? {} } catch {}
  for (const [name, range] of Object.entries(want)) if (!have[name]) console.log(`${name}@${range}`)
' "$src/package.json" "$dst/package.json")
if [ -n "$missing" ]; then
  echo "apply.sh: the fork needs dependencies the release lacks:" >&2
  for spec in $missing; do echo "  $spec" >&2; done
  # Word splitting is intended: one package spec per line, none containing a space.
  # shellcheck disable=SC2086
  ( cd "$profile" && pnpm add $missing "${store_args[@]}" ) >&2
fi

version=$(node -p "require('$dst/package.json').version" 2>/dev/null || echo '?')
echo "applied toqoz/main (ds-bot $version) into $dst"
echo "reload the DSH page to pick it up; rerun this after a DS Bot update"
echo "restart DSH after a version change, since a loaded plugin keeps the old code"
