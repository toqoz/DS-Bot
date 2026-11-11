---
name: ds-bot-personal-fork
description: Use when creating, updating, rebasing, publishing, or applying a personal change in the toqoz/DS-Bot fork of Fei2411/DS-Bot, or when importing a new upstream DS Bot into it.
---

# Personal fork of DS Bot

This checkout is a personal fork of [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot), kept for the changes this operator runs and never proposed upstream. The procedure and its scripts live on the orphan branch `toqoz/ops`, mounted in the worktree `.git/wt/ops`; they are never merged into the code.

## Branch model

| Ref | Meaning |
| --- | --- |
| `upstream/main` | The only upstream: Fei2411/DS-Bot's released branch, fetched from `https://github.com/Fei2411/DS-Bot`. |
| `toqoz/feat/<slug>` | One personal change: exactly one commit on the current upstream, with an ordinary commit message. |
| `toqoz/main` | Integration branch: upstream plus one commit holding every `toqoz/feat/*`. Its message is one bare gist URL. |
| `toqoz/ops` | Orphan branch holding this file, `sync.sh` and `apply.sh`. Never merged into the code. |

The fork's own branches are those `toqoz/*` refs and nothing else: upstream branches
are read through the `upstream` remote, never copied into the fork. The fork's default
branch is `toqoz/main`.

Hard rules:

- A `toqoz/feat/*` branch holds exactly one non-merge commit with a normal commit message.
- A commit whose subject is one bare gist URL is an integration commit, never a personal change.
- `toqoz/main` holds exactly one commit on upstream and is rebuilt by the script. Never commit on it by hand.
- The `toqoz/main` commit message is one bare gist URL and nothing else.
- The gist records what changed and why in Japanese, concisely. It summarizes and points here; this file is the only home of the procedure.
- A human edit to the gist that changes the procedure must land in this file in the same run.
- `ds-bot/client.js` is generated. Change `ds-bot/src/client/`, run `npm run build` in `ds-bot/`, and commit both; `sync.sh` rebuilds it on every rewritten branch.
- Nothing on `toqoz/ops` is rebased or merged; it has no common ancestor with upstream.

## Bootstrap

The build and the tests need packages the checkout does not carry. Install them once in the main checkout:

```sh
cd ~/src/github.com/toqoz/DS-Bot
npm --prefix ds-bot ci                                   # esbuild for the bundle
npm --prefix ds-bot run harness                          # DSH packages for the tests and the lint
git worktree add .git/wt/ops toqoz/ops                   # the procedure
ln -s ../../.git/wt/ops/.agents/skills/ds-bot-personal-fork .agents/skills/ds-bot-personal-fork
printf '.agents/skills/ds-bot-personal-fork\n' >> .git/info/exclude
```

The link is untracked and excluded locally; it survives branch switches and
`git reset --hard`, and it is how DSH finds this skill from a session started in
the checkout.

`sync.sh` reads esbuild from the main checkout's `ds-bot/node_modules`; `apply.sh` writes the built package into the profile DSH runs.

## Start a change

```sh
git fetch upstream main --prune
git switch -c toqoz/feat/<slug> upstream/main
# make the change, update its tests and docs, verify
cd ds-bot && npm run build && npm test && npm run lint && node scripts/build-client.mjs --check && cd ..
git add -A
git commit -m "<commit message>"
.git/wt/ops/.agents/skills/ds-bot-personal-fork/scripts/sync.sh --push
```

Then bring the checkout you run from up to date, verify, and apply:

```sh
git switch toqoz/main
git reset --hard toqoz/main
cd ds-bot && npm test && node scripts/build-client.mjs --check && cd ..
.git/wt/ops/.agents/skills/ds-bot-personal-fork/scripts/apply.sh
```

Switch before resetting: `sync.sh` never moves the caller's checkout, and resetting while a change branch is checked out would move that branch to the integration commit. `apply.sh` copies the package into the profile DSH runs and refuses when the profile holds another version; reload the page afterwards.

## Change an existing branch

```sh
git switch toqoz/feat/<slug>
# edit and verify
git add -A
git commit --amend --no-edit
.git/wt/ops/.agents/skills/ds-bot-personal-fork/scripts/sync.sh --push
git switch toqoz/main
git reset --hard toqoz/main
.git/wt/ops/.agents/skills/ds-bot-personal-fork/scripts/apply.sh
```

## Update the gist

`toqoz/main` keeps the gist URL of the previous run. Rewrite the gist only when the personal delta changes materially, then rebuild with the new URL:

```sh
gh gist edit <id> --filename ds-bot-toqoz-fork.md ds-bot-toqoz-fork.md   # last path is the local file
# or, for a new gist
gh gist create --public --desc "DS Bot 個人 fork の変更" --filename ds-bot-toqoz-fork.md - < ds-bot-toqoz-fork.md
.git/wt/ops/.agents/skills/ds-bot-personal-fork/scripts/sync.sh --message <gist-url> --push
```

The gist is public; visibility is fixed at creation, so create a new gist (and repoint the commit message) if it was made secret by mistake. Write it in Japanese, short and factual: what changed, why, and how it was verified. Sections are optional; do not pad it.

## Import upstream

The scheduled task runs this; a human runs it the same way.

```sh
git fetch upstream main --prune
.git/wt/ops/.agents/skills/ds-bot-personal-fork/scripts/sync.sh --push
git switch toqoz/main
git reset --hard toqoz/main
cd ds-bot && npm test && cd ..
.git/wt/ops/.agents/skills/ds-bot-personal-fork/scripts/apply.sh
```

`upstream/main` is DS Bot's released branch, so an import moves between releases. When the checkout's version differs from the one the profile installed, `apply.sh` installs that release into the profile first and then copies the fork's files over it, so one import run leaves the profile on the new release. `--no-upgrade` stops at the mismatch instead. After DS Bot's in-app update reinstalls the npm package, the profile holds the npm copy again: rerun `apply.sh` to put the fork back.

## The script

`sync.sh`:

1. fetches `upstream/main`;
2. refuses unless every `toqoz/feat/*` holds exactly one non-merge personal commit, not counting a stale upstream integration commit it sits on;
3. rebases each branch onto upstream in a temporary worktree, dropping that stale commit, rebuilds `ds-bot/client.js` from the rebased sources and amends the commit, and leaves a worktree behind when a rebase conflicts;
4. rebuilds `toqoz/main` as upstream plus one squash commit of every `toqoz/feat/*` in a temporary worktree, rebuilding the bundle again, reusing the gist URL of the previous run, and discarding the rebuild when two branches overlap;
5. with `--push`, publishes each branch with `--force-with-lease` and `--no-verify`.

Publishing skips the repository pre-push hook because the ops worktree has no `package.json`; the reset-and-verify step above is the gate instead, and it runs after the push.

## Publish and credentials

`git push` and `gh gist` both need GitHub authentication. Confirm it before a run that publishes:

```sh
gh auth status
```

If the token is invalid, stop and ask the operator to run `gh auth login`; do not invent a commit message to work around a missing gist.

## Conflict policy

- Upstream changed a file the branch also changed: resolve the rebase in the temporary worktree the script names, run `npm run build` there (the bundle is regenerated and the commit amended on the next run), then remove that worktree and rerun.
- Upstream implemented the personal change: delete the `toqoz/feat/*` branch and drop that section from the gist.
- Two branches conflict with each other: fix the pair in the newer branch or split the shared part into its own branch; the rebuild is discarded on overlap, so nothing is left half-applied.
