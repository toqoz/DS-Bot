# toqoz/ops

Operations for the personal fork of DS Bot, on an orphan branch with no common
ancestor with the code.

- `.agents/skills/ds-bot-personal-fork/SKILL.md` — the procedure: branch model,
  how to start, update and import upstream, how to apply to the running profile.
- `.agents/skills/ds-bot-personal-fork/scripts/sync.sh` — rebase every change
  branch onto upstream, rebuild the integration branch and the client bundle,
  publish.
- `.agents/skills/ds-bot-personal-fork/scripts/apply.sh` — copy the built plugin
  into the profile DSH runs.

If this branch is missing from a fresh clone, restore it:

```sh
git fetch origin toqoz/ops
git worktree add .git/wt/ops toqoz/ops
```

DSH discovers the skill from the project root of a session's working directory.
A session started in `~/src/github.com/toqoz/DS-Bot` therefore sees it only while
the main checkout has it linked, which it never does after `git reset --hard`:

```sh
ln -s ../../.git/wt/ops/.agents/skills/ds-bot-personal-fork .agents/skills/ds-bot-personal-fork
printf '.agents/skills/ds-bot-personal-fork\n' >> .git/info/exclude
```
