# Repository Maintenance Rules

`nzh10-skills` stores cross-machine Pi configuration (`canon/`), sanitized per-machine incubator pools (`pools/`), global extensions (`extensions/`), and reusable skills (`skills/`).

## Directory and File Boundaries

- Edit `canon/settings.canon.json`, `canon/AGENTS.md`, and `canon/plain-check.toml` for cross-machine defaults. On writable clones (`machine.json` with `hubRepoPath`), `pi-steward` maps the `nzh10-skills` package in `~/.pi/agent/settings.json` directly to `hubRepoPath` and reconciles `canon/AGENTS.md` and `canon/plain-check.toml` to `~/.pi/agent/` on startup and `/reload`; update the matching `~/.pi/agent/` copy immediately when the active session needs a config change before reload.
- Keep `pools/<machineId>/incubating.json` limited to cross-machine `npm:` and `git:` package sources. Keep `pools/<machineId>/machine-env.md` free of usernames, hostnames, home paths, and private network addresses.
- Treat `skills/skill-creator/`, `patches/skill-creator.patch`, `scripts/sync-skill-creator.sh`, `upstream.json`, and `.github/workflows/sync-skill-creator.yml` as upstream-managed paths. Edit them only when the user explicitly requests changes to `skill-creator` sync, and keep `patches/skill-creator.patch` limited to `claude`-to-`pi` adaptations and verified script fixes.
- Read `skills/pi-steward/SKILL.md` completely before you promote, remove, or pool packages, models, or machine configs.

## Privacy and Hook Redlines

- Keep `git config core.hooksPath .githooks` and `git config branch.master.rebase true` enabled and `.git/info/no-upload-personal` populated in every writable clone.
- Do not pass `--no-verify` (or `git commit -n`) to `git commit` or `git push`.
- Do not stage or commit `machine.json`, `.pi-steward-state.json`, `APPEND_SYSTEM.md`, credentials, real usernames, hostnames, local home paths, or live workspace IDs.

## Git Commit and Release Rules

- Use the existing pre-commit hook to catch invalid submitted files before they enter history. It checks index content for privacy, Pi settings structure, extension default registration functions, plain-check rules, and Node JS/TS syntax. TypeScript is stripped with Node's built-in parser before JavaScript syntax checking; staged extension inputs use a small temporary directory for the existing import checks.
- Run `scripts/check-repo.sh` and `node --test tests/guardrails.test.ts` before committing changes to extensions, canon rules, or hooks.
- Stage explicit file paths (`git add -- <paths>`) and review `git diff --cached` before each commit.
- Use unscoped Conventional Commit subjects (`feat: ...`, `fix: ...`, `chore: ...`) in imperative mood.
- Group each logical change into one self-contained commit so related edits land together without fixup churn. Direct commits on `master` are supported; use a local branch optionally for multi-day experiments, and run `git pull --rebase` when `origin/master` has new commits before pushing.
- Run `git push` only when the user explicitly requests a push. Writable clones load `extensions/` and `skills/` directly from `hubRepoPath` on `/reload`; after an authorized push, read-only sync nodes reconcile `<agentDir>/git/github.com/nzh10/nzh10-skills` to `origin/master` on `/reload` or startup.
