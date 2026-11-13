# Repository Maintenance Rules

`nzh10-skills` stores cross-machine Pi configuration (`canon/`), sanitized per-machine incubator pools (`pools/`), global extensions (`extensions/`), and reusable skills (`skills/`).

## Directory and File Boundaries

- Edit `canon/settings.canon.json`, `canon/AGENTS.md`, and `canon/plain-check.toml` for cross-machine defaults. `pi-steward` reconciles `canon/AGENTS.md` and `canon/plain-check.toml` to `~/.pi/agent/` automatically on startup and `/reload`; update the matching `~/.pi/agent/` copy immediately when the active session needs the change before reload.
- Keep `pools/<machineId>/incubating.json` limited to cross-machine `npm:` and `git:` package sources. Keep `pools/<machineId>/machine-env.md` free of usernames, hostnames, home paths, and private network addresses.
- Treat `skills/skill-creator/`, `patches/skill-creator.patch`, `scripts/sync-skill-creator.sh`, `upstream.json`, and `.github/workflows/sync-skill-creator.yml` as upstream-managed paths. Edit them only when the user explicitly requests changes to `skill-creator` sync, and keep `patches/skill-creator.patch` limited to `claude`-to-`pi` adaptations and verified script fixes.
- Read `skills/pi-steward/SKILL.md` completely before you promote, remove, or pool packages, models, or machine configs.

## Privacy and Hook Redlines

- Keep `git config core.hooksPath .githooks` enabled and `.git/info/no-upload-personal` populated in every writable clone.
- Do not pass `--no-verify` (or `git commit -n`) to `git commit` or `git push`.
- Do not stage or commit `machine.json`, `.pi-steward-state.json`, `APPEND_SYSTEM.md`, credentials, real usernames, hostnames, local home paths, or live workspace IDs.

## Git Commit and Release Rules

- Run `scripts/check-repo.sh` and `node --test tests/guardrails.test.ts` before committing changes to extensions, canon rules, or hooks.
- Stage explicit file paths (`git add -- <paths>`) and review `git diff --cached` before each commit.
- Use unscoped Conventional Commit subjects (`feat: ...`, `fix: ...`, `chore: ...`) in imperative mood.
- Group each logical change into one self-contained commit so related edits land together without fixup churn.
- Run `git push` only when the user explicitly requests a push. After an authorized push, `/reload` (or the next interactive Pi startup) reconciles the local package cache (`~/.pi/agent/git/github.com/nzh10/nzh10-skills`) to `origin/master`; run `/reload` once more when extension code changed.
