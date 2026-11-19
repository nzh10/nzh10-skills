# pi-skillful Guidelines

Root `AGENTS.md` applies.

## Invariants

- Hidden skills remain explicitly invokable.
- Package-bundled skills are never assigned new toggle slots. Visibility additionally accepts only verified hub package resources under the hub's real `skills/` root; third-party package skills remain untouched.
- Project settings require active trust; global inheritance remains intact.
- Compose editor wrappers with focus, IME, hooks, and previous editor behavior.
- Startup coloring uses private Pi UI API: isolate it and keep integration coverage that fails if patch wiring disappears.

## Validation

```bash
npm run -w packages/pi-skillful check
npm test -w packages/pi-skillful
npm run -w packages/pi-skillful pack:dry-run
```

Smoke test `/skillful`, startup colors, hidden invocation, inline invocation, and configured shortcuts after UI changes.

For startup-renderer changes, use a disposable Pi profile with one hidden and one visible skill. Check the collapsed `[Skills]` colors in regular and fullscreen modes, expand/collapse the resource list, change themes, and run `/reload`. Expanded paths must remain native; collapsed colors must follow the current theme and settings without duplicating sections.

## Architecture

Four features are wired in `extensions/index.ts`. There is no runtime build step; `check` type-checks, and `test` compiles the package into a disposable `.test-dist/` before running `tests/*.test.mjs`.

1. **Progressive skill discovery** (`src/extensions/progressive-skills.ts`): hooks `pi.on("resources_discover")` to add `.agents/skills/` directories from every ancestor above the git root, which Pi's own discovery stops at. `~/.agents/skills` is skipped because Pi loads it globally.
2. **Inline skill invocation** (`src/extensions/inline-skill-invocation.ts`): hooks `pi.on("input")` to expand `/skill:name` markers anywhere in the prompt, not just at the start. Each known marker is replaced with a `<skill>` block built from the skill's `SKILL.md` (`readSkillBlock`) and the input is transformed before Pi's own expansion runs; unknown or unreadable skills produce a warning notice.
3. **Skill visibility** (`src/extensions/skill-visibility.ts`): hooks `pi.on("before_agent_start")` and marks hidden top-level skills `disableModelInvocation: true` in `event.systemPromptOptions.skills`, so Pi omits them from the prompt's skill list. Only actually pressed session shortcuts override persistent per-item visibility. Also registers the `/skillful` command, a TUI menu backed by `SettingsList`.
   The startup `[Skills]` list is colorized by `installStartupSkillListPatch`, which monkey-patches `InteractiveMode.prototype.showLoadedResources`. It records skill names through a temporary `resourceLoader.getSkills` wrapper, then decorates the `[Skills]` entry: on Pi 1.x it wraps the component's `build()` and colorizes only the collapsed text; on older Pi it replaces `getCollapsedText`. Colors are computed lazily from scoped settings in `store.scopedByCwd` and the current theme. `Symbol.for("pi-skillful.startupPatchV5")` on the prototype guards against double-patching across hot reloads; the singleton store is keyed at `Symbol.for("pi-skillful.skillVisibilityStore")` on `globalThis`.
4. **Session skill toggles** (`src/extensions/session-skill-toggles.ts`): assigns skills to keyboard shortcut slots `1`–`9` through `skillful.toggleSlots`, with the modifier from `skillful.toggleModifier` (default `alt`, for example Alt+1). Renders active/inactive state in the top border of a custom editor; when another extension already set an editor, it wraps that editor instead of replacing it. Hooks `before_agent_start` to mark toggled-off top-level skills `disableModelInvocation: true` in `event.systemPromptOptions.skills`. Slot active-state survives a `session_shutdown`/`session_start` pair with reason `"new"` in the same cwd; the store is keyed at `Symbol.for("pi-skillful.sessionSkillTogglesStore")`.

| Module | Role |
|---|---|
| `src/config.ts` | Reads/writes per-identity `skillful.visibility`, legacy `skillful.hiddenSkills`, `skillful.toggleSlots`, and `skillful.toggleModifier` in `<getAgentDir()>/settings.json` and `<cwd>/<CONFIG_DIR_NAME>/settings.json`. Project settings are read only when trusted. Visibility resolves each identity Project > Global > read-only Global `visibilityDefaults` > Pi. Legacy name lists retain replacement semantics for top-level skills only; toggles retain independent scope inheritance. Writes merge the locked current document and rename atomically under the SDK same-scope lock. |
| `src/skills.ts` | Lists loaded skills from Pi commands (`listLoadedSkills`, `sourceInfoToSkill`), classifies top-level skills (`isTopLevelSkill`), and reads a skill's `SKILL.md` into a `<skill>` block with frontmatter stripped (`readSkillBlock`). |
| `src/visibility.ts` | Shared loaded-source qualification, portable identity selection, legacy compatibility and per-item precedence. |
| `src/install-telemetry.ts` | Best-effort install telemetry (root policy). |
