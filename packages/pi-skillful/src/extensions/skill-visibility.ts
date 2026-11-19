import { stripVTControlCharacters } from "node:util";
import {
  DynamicBorder,
  getSettingsListTheme,
  InteractiveMode,
  type ExtensionAPI,
  type Skill,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type SettingItem, SettingsList, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import {
  normalizeSkillName,
  readScopedSkillfulSettings,
  SKILL_TOGGLE_SLOTS,
  type SkillfulScope,
  type SkillToggleSlot,
  type SkillVisibility,
  updateSkillVisibility,
  updateToggleSlots,
} from "../config.js";
import { isTopLevelSkill, listLoadedSkills, type LoadedSkillInfo } from "../skills.js";
import { scopedSkillChoice, skillVisibilityId, visibilityEligible, type ScopedSettings } from "../visibility.js";
import { sessionSkillIsHidden, refreshSessionSkillToggles } from "./session-skill-toggles.js";
const SCOPES: SkillfulScope[] = ["global", "project"];
const STORE_KEY = Symbol.for("pi-skillful.skillVisibilityStore");
// Install the new component contract even after reloading a V3-patched process.
const STARTUP_PATCH_KEY = Symbol.for("pi-skillful.startupPatchV5");

interface SkillVisibilityStore {
  scopedByCwd?: Map<string, ScopedSettings>;
  theme: Theme | null;
  getTheme?: () => Theme;
}

interface ExpandableTextLike {
  getCollapsedText?: () => string;
  build?: () => string;
  invalidate?: () => void;
  setText: (text: string) => void;
}

interface BoxLike {
  children: unknown[];
}

interface InteractiveModeLike {
  loadedResourcesContainer?: BoxLike;
  showLoadedResources?: (options?: unknown) => void;
  getStartupExpansionState?: () => boolean;
  session?: { resourceLoader?: { getSkills: () => { skills: Skill[]; diagnostics: unknown[] } } };
  sessionManager?: { getCwd?: () => string };
}

const store = (((globalThis as Record<PropertyKey, unknown>)[STORE_KEY] as SkillVisibilityStore | undefined) ??= {
  theme: null,
}) as SkillVisibilityStore;

type SkillListItem = LoadedSkillInfo;
interface SkillfulVisibilityMenuOptions {
  cwd: string;
  projectTrusted: boolean;
  skills: SkillListItem[];
  scoped: ScopedSettings;
  theme: Theme;
  tui: TUI;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  onToggleSlotsChanged: () => Promise<void>;
  done: () => void;
}

interface SettingsListSelectionView {
  filteredItems?: SettingItem[];
  items?: SettingItem[];
  selectedIndex?: number;
  submenuComponent?: unknown;
}

export default function skillVisibility(pi: ExtensionAPI) {
  installStartupSkillListPatch();

  pi.on("session_start", async (_event, ctx) => {
    store.theme = ctx.ui.theme;
    store.getTheme = () => ctx.ui.theme;
    await refreshHiddenSkillCache(ctx.cwd, ctx.isProjectTrusted());
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const scoped = await refreshHiddenSkillCache(ctx.cwd, ctx.isProjectTrusted());
    if (!scoped || !event.systemPromptOptions.skills?.length) return;
    event.systemPromptOptions.skills = event.systemPromptOptions.skills.map((skill) => {
      const hidden = sessionSkillIsHidden(skill, ctx.cwd, scoped);
      return hidden ? { ...skill, disableModelInvocation: true } : skill;
    });
  });

  pi.registerCommand("skillful", {
    description: "Open the pi-skillful skill visibility menu.",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/skillful requires interactive UI", "warning");
        return;
      }

      const skills = getSkillItems(pi, ctx.cwd);
      if (skills.length === 0) {
        ctx.ui.notify("No skills are currently loaded.", "info");
        return;
      }

      const projectTrusted = ctx.isProjectTrusted();
      let scoped: ScopedSettings;
      try { scoped = await readScopedSkillfulSettings(ctx.cwd, projectTrusted); }
      catch (error) { ctx.ui.notify(`Cannot read skill visibility: ${String(error)}`, "error"); return; }
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
        new SkillfulVisibilityMenu({
          cwd: ctx.cwd,
          projectTrusted,
          skills,
          scoped,
          theme,
          tui,
          notify: (message, type) => ctx.ui.notify(message, type),
          onToggleSlotsChanged: () => refreshSessionSkillToggles(pi, ctx.cwd, projectTrusted, ctx.ui),
          done,
        }),
      );
    },
  });
}

async function refreshHiddenSkillCache(cwd: string, projectTrusted: boolean): Promise<ScopedSettings | undefined> {
  store.scopedByCwd ??= new Map();
  try {
    const scoped = await readScopedSkillfulSettings(cwd, projectTrusted);
    store.scopedByCwd.set(cwd, scoped);
    return scoped;
  } catch {
    // A partial/invalid settings write must not unhide the last good selection.
    const previous = store.scopedByCwd.get(cwd);
    if (previous && !projectTrusted) {
      const safe = { ...previous, project: { ...previous.project, visibility: {}, hiddenSkillsDefined: false, visibleSkills: [] } };
      store.scopedByCwd.set(cwd, safe);
      return safe;
    }
    return previous;
  }
}

// Pi has no public hook for styling the built-in startup resource list, so patch the
// prototype from Pi's own module and keep the workaround isolated here.
export function installStartupSkillListPatch(
  realPrototype: InteractiveModeLike = (InteractiveMode as unknown as { prototype: InteractiveModeLike }).prototype,
): void {
  if (!realPrototype) return;

  const patchState = realPrototype as Record<PropertyKey, unknown>;
  if (patchState[STARTUP_PATCH_KEY]) return;

  const original = realPrototype.showLoadedResources;
  if (typeof original !== "function") return;

  realPrototype.showLoadedResources = function (this: InteractiveModeLike, options?: unknown): void {
    const loader = this.session?.resourceLoader;
    const originalGetSkills = loader?.getSkills;
    if (!loader || typeof originalGetSkills !== "function") {
      original.call(this, options);
      return;
    }

    const cwd = this.sessionManager?.getCwd?.();
    let rawSkills: Skill[] = [];
    let rawSkillNames: string[] = [];
    loader.getSkills = () => {
      const result = originalGetSkills.call(loader);
      rawSkills = result.skills;
      rawSkillNames = result.skills.map((skill) => normalizeSkillName(skill.name));
      return result;
    };

    try {
      original.call(this, options);
    } finally {
      loader.getSkills = originalGetSkills;
    }

    if (rawSkillNames.length === 0 || !cwd || !this.loadedResourcesContainer) return;

    const colorized = () => buildColorizedSkillList(
      rawSkillNames,
      new Set(rawSkills.filter(skill => {
        const scoped = store.scopedByCwd?.get(cwd);
        return !!scoped && sessionSkillIsHidden(skill, cwd, scoped);
      }).map(skill => skill.name)),
      store.getTheme?.() ?? store.theme,
    );
    const collapsedText = buildColorizedSkillList(rawSkillNames, new Set(), null);
    // Pi clears and rebuilds this container, including during /reload.
    for (const entry of this.loadedResourcesContainer.children) {
      const child = entry as ExpandableTextLike | undefined;
      if (child && typeof child.build === "function") {
        // Pi 1.x closes over expansion state in ThemedText.build instead of
        // exposing getCollapsedText. Decorate only the compact skill list;
        // leave expanded paths and other sections to Pi. Rebuild colors on
        // invalidation so theme changes never retain captured ANSI strings.
        const build = child.build;
        if (!stripVTControlCharacters(build.call(child)).startsWith("[Skills]\n")) continue;
        child.build = () => {
          const text = build.call(child);
          return stripVTControlCharacters(text) === collapsedText ? colorized() : text;
        };
        child.invalidate?.();
        break;
      }
      if (!child || typeof child.getCollapsedText !== "function") continue;
      if (!child.getCollapsedText().includes("[Skills]")) continue;

      // Retain the older Pi component contract without collapsing an
      // initially expanded resource listing.
      child.getCollapsedText = colorized;
      if (!this.getStartupExpansionState?.()) child.setText(colorized());
      break;
    }
  };

  patchState[STARTUP_PATCH_KEY] = true;
}

export function buildColorizedSkillList(names: string[], hidden: Set<string>, theme: Theme | null): string {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (!theme) return `[Skills]\n  ${sorted.join(", ")}`;

  const header = theme.fg("mdHeading", "[Skills]");
  const parts = sorted.map((name) => (hidden.has(name) ? theme.fg("error", name) : theme.fg("dim", name)));
  return `${header}\n  ${parts.join(", ")}`;
}

function getSkillItems(pi: ExtensionAPI, cwd: string): SkillListItem[] {
  return listLoadedSkills(pi.getCommands()).filter(skill => visibilityEligible(skill, cwd));
}

class SkillfulVisibilityMenu implements Component {
  private readonly cwd: string;
  private readonly projectTrusted: boolean;
  private readonly scopes: SkillfulScope[];
  private readonly skills: SkillListItem[];
  private scoped: ScopedSettings;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
  private readonly onToggleSlotsChanged: () => Promise<void>;
  private readonly done: () => void;
  private readonly topBorder: DynamicBorder;
  private readonly bottomBorder: DynamicBorder;
  private scope: SkillfulScope;
  private settingsList: SettingsList;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(options: SkillfulVisibilityMenuOptions) {
    this.cwd = options.cwd;
    this.projectTrusted = options.projectTrusted;
    this.scopes = options.projectTrusted ? SCOPES : ["global"];
    this.scope = options.projectTrusted ? "project" : "global";
    this.skills = options.skills;
    this.scoped = options.scoped;
    this.theme = options.theme;
    this.tui = options.tui;
    this.notify = options.notify;
    this.onToggleSlotsChanged = options.onToggleSlotsChanged;
    this.done = options.done;
    this.topBorder = new DynamicBorder((text: string) => this.theme.fg("accent", text));
    this.bottomBorder = new DynamicBorder((text: string) => this.theme.fg("accent", text));
    this.settingsList = this.createSettingsList();
  }

  render(width: number): string[] {
    this.refreshItemDetails();
    return [
      ...this.topBorder.render(width),
      truncateToWidth(`  ${this.theme.bold(this.theme.fg("accent", "pi-skillful"))}  ${this.renderTabs()}`, width),
      truncateToWidth(this.theme.fg("dim", "  Toggle skills shown in the model-invocation system prompt"), width),
      "",
      ...this.settingsList.render(width),
      "",
      truncateToWidth(this.theme.fg("dim", this.renderHelp()), width),
      ...this.bottomBorder.render(width),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.switchScope(1);
      return;
    }
    if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.left)) {
      this.switchScope(-1);
      return;
    }
    if (/^[1-9]$/.test(data)) {
      this.toggleSelectedSkillSlot(data as SkillToggleSlot);
      return;
    }

    this.settingsList.handleInput(data);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.topBorder.invalidate();
    this.bottomBorder.invalidate();
    this.settingsList.invalidate();
  }

  private renderTabs(): string {
    return this.scopes
      .map((scope) => {
        const label = scope === "global" ? "Global" : "Project";
        return scope === this.scope
          ? this.theme.bg("selectedBg", this.theme.fg("accent", ` ${label} `))
          : this.theme.fg("muted", ` ${label} `);
      })
      .join(" ");
  }

  private renderHelp(): string {
    const scopeHelp = this.projectTrusted ? "Tab/←/→ switch scope · " : "";
    return `  ${scopeHelp}1-9 assign/clear toggle · Enter/Space show/hide/inherit · Esc close`;
  }

  private switchScope(direction: 1 | -1): void {
    const current = this.scopes.indexOf(this.scope);
    this.scope = this.scopes[(current + direction + this.scopes.length) % this.scopes.length];
    this.settingsList = this.createSettingsList();
    this.tui.requestRender();
  }

  private createSettingsList(): SettingsList {
    const items: SettingItem[] = this.skills.map((skill) => {
      return {
        id: skill.name,
        label: skill.name,
        description: this.skillDescription(skill),
        currentValue: this.skillValue(skill.name),
        values: ["show", "hide", "inherit"],
      };
    });

    return new SettingsList(
      items,
      12,
      getSettingsListTheme(),
      (id, newValue) => {
        const choice = newValue.trim().split(/\s+/)[0] as SkillVisibility;
        const skill = this.skills.find(skill => skill.name === id)!;
        const identity = skillVisibilityId(skill, this.scope, this.cwd);
        if (!identity) {
          this.notify("This external skill has no portable Project identity; use Global instead.", "warning");
          this.settingsList.updateValue(id, this.skillValue(id));
          return;
        }
        this.settingsList.updateValue(id, choice);
        this.persistScope(this.scope, skill, identity, choice);
      },
      () => this.close(),
      { enableSearch: true },
    );
  }

  private skillDescription(skill: SkillListItem): string {
    return `${skill.description || "No skill description provided."}\nEffective: ${sessionSkillIsHidden(skill, this.cwd, this.scoped) ? "hide" : "show"} (Pi manual-only restrictions remain).${isTopLevelSkill(skill) ? " Press 1-9 to assign/clear a toggle slot." : " Public package skill; no new shortcut slots."}`;
  }

  private refreshItemDetails(): void {
    const list = this.settingsList as unknown as SettingsListSelectionView;
    for (const item of list.items ?? []) {
      const skill = this.skills.find(skill => skill.name === item.id)!;
      const slot = isTopLevelSkill(skill) ? SKILL_TOGGLE_SLOTS.find(candidate => this.currentToggleSlots()[candidate] === skill.name) : undefined;
      item.label = `${skill.name}${slot ? ` [${slot}]` : ""}`;
      item.description = this.skillDescription(skill);
    }
  }

  private skillValue(skillName: string): string {
    const skill = this.skills.find(skill => skill.name === skillName)!;
    return scopedSkillChoice(skill, this.scope, this.cwd, this.scoped);
  }

  private currentToggleSlots(): Partial<Record<SkillToggleSlot, string>> {
    if (this.scope === "project" && !this.scoped.project.toggleSlotsDefined) return this.scoped.global.toggleSlots;
    return this.scoped[this.scope].toggleSlots;
  }

  private ensureWritableToggleSlots(scope: SkillfulScope): Partial<Record<SkillToggleSlot, string>> {
    if (scope === "project" && !this.scoped.project.toggleSlotsDefined) {
      this.scoped.project.toggleSlots = { ...this.scoped.global.toggleSlots };
    }
    this.scoped[scope].toggleSlotsDefined = true;
    return this.scoped[scope].toggleSlots;
  }

  private toggleSelectedSkillSlot(slot: SkillToggleSlot): void {
    const skillName = this.selectedSkillName();
    if (!skillName || !isTopLevelSkill(this.skills.find(skill => skill.name === skillName)!)) return;

    const toggleSlots = this.ensureWritableToggleSlots(this.scope);
    const affected = new Set<string>([skillName]);
    const previousSkill = toggleSlots[slot];
    if (previousSkill) affected.add(previousSkill);

    const clear = previousSkill === skillName;
    const changeSlot = (current: Partial<Record<SkillToggleSlot, string>>) => {
      if (clear) {
        if (current[slot] === skillName) delete current[slot];
      } else {
        for (const candidate of SKILL_TOGGLE_SLOTS) {
          if (current[candidate] === skillName) delete current[candidate];
        }
        current[slot] = skillName;
      }
      return current;
    };
    changeSlot(toggleSlots);

    for (const affectedSkill of affected) {
      if (this.skills.some(skill => skill.name === affectedSkill)) this.settingsList.updateValue(affectedSkill, this.skillValue(affectedSkill));
    }
    this.persistToggleSlots(this.scope, changeSlot);
    this.tui.requestRender();
  }

  private selectedSkillName(): string | undefined {
    const list = this.settingsList as unknown as SettingsListSelectionView;
    if (list.submenuComponent) return undefined;
    const items = list.filteredItems ?? list.items ?? [];
    const selectedIndex = list.selectedIndex ?? 0;
    return items[selectedIndex]?.id;
  }

  private persistScope(scope: SkillfulScope, skill: SkillListItem, identity: string, choice: SkillVisibility): void {
    this.saveQueue = this.saveQueue.catch(() => undefined).then(async () => {
      await updateSkillVisibility(scope, this.cwd, identity, skill.name, choice, isTopLevelSkill(skill), this.projectTrusted);
      const scoped = await refreshHiddenSkillCache(this.cwd, this.projectTrusted);
      if (scoped) this.scoped = scoped;
      this.settingsList.updateValue(skill.name, this.skillValue(skill.name));
      this.tui.requestRender();
    }).catch(error => {
      this.notify(`Failed to save ${scope} skill visibility: ${String(error)}`, "error");
      this.settingsList.updateValue(skill.name, this.skillValue(skill.name));
      this.tui.requestRender();
    });
  }

  private persistToggleSlots(
    scope: SkillfulScope,
    update: (current: Partial<Record<SkillToggleSlot, string>>) => Partial<Record<SkillToggleSlot, string>>,
  ): void {
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        await updateToggleSlots(scope, this.cwd, update, this.projectTrusted);
        this.scoped = await readScopedSkillfulSettings(this.cwd, this.projectTrusted);
        this.tui.requestRender();
      })
      .catch((error) => {
        this.notify(`Failed to save ${scope} skill toggles: ${error instanceof Error ? error.message : String(error)}`, "error");
      });
  }

  private close(): void {
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(() => this.onToggleSlotsChanged())
      .catch((error) => {
        this.notify(`Failed to refresh session skill toggles: ${error instanceof Error ? error.message : String(error)}`, "error");
      })
      .finally(() => this.done());
  }

}
