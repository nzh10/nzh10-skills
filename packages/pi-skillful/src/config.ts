import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export type SkillfulScope = "global" | "project";
export type SkillToggleSlot = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
export const SUPPORTED_TOGGLE_MODIFIERS = [
  "alt",
  "ctrl",
  "ctrl+shift",
  "alt+shift",
  "ctrl+alt",
  "ctrl+alt+shift",
] as const;
export type SkillToggleModifier = (typeof SUPPORTED_TOGGLE_MODIFIERS)[number];

export interface SkillToggleConfig {
  toggleSlots: Partial<Record<SkillToggleSlot, string>>;
  toggleModifier: SkillToggleModifier;
}

export type SkillVisibility = "show" | "hide" | "inherit";
export type SkillVisibilityMap = Record<string, SkillVisibility>;

export interface SkillfulSettings extends SkillToggleConfig {
  visibility: SkillVisibilityMap;
  visibilityDefaults: SkillVisibilityMap;
  hiddenSkills: string[];
  hiddenSkillsDefined: boolean;
  visibleSkills: string[];
  toggleSlotsDefined: boolean;
  toggleModifierDefined: boolean;
}

export interface EffectiveSkillfulSettings extends SkillfulSettings {
  hiddenSkillSet: Set<string>;
  scoped: Record<SkillfulScope, SkillfulSettings>;
}

interface PiSettingsDocument {
  skillful?: Partial<SkillfulSettings>;
  [key: string]: unknown;
}

export const SKILLFUL_SETTINGS_KEY = "skillful";
export const SKILL_TOGGLE_SLOTS: SkillToggleSlot[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
export const DEFAULT_TOGGLE_MODIFIER: SkillToggleModifier = "alt";

const SUPPORTED_TOGGLE_MODIFIERS_SET: ReadonlySet<string> = new Set(SUPPORTED_TOGGLE_MODIFIERS);

export function globalSettingsPath(): string {
  // Honor PI_CODING_AGENT_DIR and Pi's config directory name like Pi itself.
  return join(getAgentDir(), "settings.json");
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

export function settingsPath(scope: SkillfulScope, cwd: string): string {
  return scope === "global" ? globalSettingsPath() : projectSettingsPath(cwd);
}

export function normalizeSkillName(name: string): string {
  return name.trim().replace(/^skill:/, "");
}

export function normalizeSkillNames(names: Iterable<string>): string[] {
  return Array.from(
    new Set(
      Array.from(names)
        .map(normalizeSkillName)
        .filter((name) => name.length > 0)
        .sort(),
    ),
  );
}

export function normalizeToggleSlots(value: unknown): Partial<Record<SkillToggleSlot, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const result: Partial<Record<SkillToggleSlot, string>> = {};
  const seenSkillNames = new Set<string>();
  const source = value as Record<string, unknown>;

  for (const slot of SKILL_TOGGLE_SLOTS) {
    const rawName = source[slot];
    if (typeof rawName !== "string") continue;

    const name = normalizeSkillName(rawName);
    if (!name || seenSkillNames.has(name)) continue;

    result[slot] = name;
    seenSkillNames.add(name);
  }

  return result;
}

export function normalizeToggleModifier(value: unknown): SkillToggleModifier {
  if (typeof value !== "string") return DEFAULT_TOGGLE_MODIFIER;
  const normalized = value.trim().toLowerCase();
  return SUPPORTED_TOGGLE_MODIFIERS_SET.has(normalized) ? (normalized as SkillToggleModifier) : DEFAULT_TOGGLE_MODIFIER;
}

async function readSettingsDocument(path: string): Promise<PiSettingsDocument> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Settings must be a JSON object.");
    return parsed as PiSettingsDocument;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function readSkillfulSettings(path: string): Promise<SkillfulSettings> {
  const settings = await readSettingsDocument(path);
  return settingsFromRecord(settings[SKILLFUL_SETTINGS_KEY]);
}

export async function readScopedSkillfulSettings(
  cwd: string,
  projectTrusted: boolean,
): Promise<Record<SkillfulScope, SkillfulSettings>> {
  const [global, project] = await Promise.all([
    readSkillfulSettings(globalSettingsPath()),
    projectTrusted ? readSkillfulSettings(projectSettingsPath(cwd)) : Promise.resolve(settingsFromRecord(undefined)),
  ]);
  return { global, project };
}

export async function readEffectiveHiddenSkills(cwd: string, projectTrusted: boolean): Promise<Set<string>> {
  const scoped = await readScopedSkillfulSettings(cwd, projectTrusted);
  return effectiveHiddenSkillSet(scoped);
}

export async function readEffectiveSkillfulSettings(
  cwd: string,
  projectTrusted: boolean,
): Promise<EffectiveSkillfulSettings> {
  const scoped = await readScopedSkillfulSettings(cwd, projectTrusted);
  const hiddenSkills = normalizeSkillNames(effectiveHiddenSkillSet(scoped));
  const toggleSlots = scoped.project.toggleSlotsDefined ? scoped.project.toggleSlots : scoped.global.toggleSlots;
  return {
    scoped,
    visibility: {},
    visibilityDefaults: scoped.global.visibilityDefaults,
    hiddenSkills,
    hiddenSkillsDefined: scoped.global.hiddenSkillsDefined || scoped.project.hiddenSkillsDefined,
    visibleSkills: [],
    hiddenSkillSet: new Set(hiddenSkills),
    toggleSlots,
    toggleSlotsDefined: scoped.global.toggleSlotsDefined || scoped.project.toggleSlotsDefined,
    toggleModifier: scoped.project.toggleModifierDefined ? scoped.project.toggleModifier : scoped.global.toggleModifier,
    toggleModifierDefined: scoped.global.toggleModifierDefined || scoped.project.toggleModifierDefined,
  };
}

export async function writeHiddenSkills(
  scope: SkillfulScope,
  cwd: string,
  hiddenSkills: Iterable<string>,
  projectTrusted = false,
): Promise<SkillfulSettings> {
  return updateSkillfulSettings(scope, cwd, projectTrusted, (current) => {
    current.hiddenSkills = normalizeSkillNames(hiddenSkills);
  });
}

export async function writeSkillVisibility(
  scope: SkillfulScope,
  cwd: string,
  hiddenSkills: Iterable<string>,
  visibleSkills: Iterable<string> = [],
  projectTrusted = false,
): Promise<SkillfulSettings> {
  return updateSkillfulSettings(scope, cwd, projectTrusted, (current) => {
    const visible = normalizeSkillNames(visibleSkills);
    current.hiddenSkills = normalizeSkillNames(hiddenSkills);
    if (visible.length === 0) delete current.visibleSkills;
    else current.visibleSkills = visible;
  });
}

export async function writeToggleSlots(
  scope: SkillfulScope,
  cwd: string,
  toggleSlots: Partial<Record<SkillToggleSlot, string>>,
  projectTrusted = false,
): Promise<SkillfulSettings> {
  return updateToggleSlots(scope, cwd, () => toggleSlots, projectTrusted);
}

export async function updateToggleSlots(
  scope: SkillfulScope,
  cwd: string,
  updater: (slots: Partial<Record<SkillToggleSlot, string>>) => Partial<Record<SkillToggleSlot, string>>,
  projectTrusted = false,
): Promise<SkillfulSettings> {
  return updateSkillfulSettings(scope, cwd, projectTrusted, (current) => {
    const inherited = scope === "project" && !Object.hasOwn(current, "toggleSlots")
      ? (existsSync(globalSettingsPath()) ? settingsFromRecord(JSON.parse(readFileSync(globalSettingsPath(), "utf-8")).skillful).toggleSlots : {}) : {};
    current.toggleSlots = normalizeToggleSlots(updater(Object.hasOwn(current, "toggleSlots") ? normalizeToggleSlots(current.toggleSlots) : inherited));
  });
}

export async function writeProjectSkillfulOverride(
  cwd: string,
  hiddenSkills: Iterable<string> | undefined,
  toggleSlots: Partial<Record<SkillToggleSlot, string>> | undefined,
  projectTrusted: boolean,
): Promise<SkillfulSettings> {
  return updateSkillfulSettings("project", cwd, projectTrusted, (current) => {
    delete current.visibleSkills;
    if (hiddenSkills === undefined) delete current.hiddenSkills;
    else current.hiddenSkills = normalizeSkillNames(hiddenSkills);
    if (toggleSlots === undefined) delete current.toggleSlots;
    else current.toggleSlots = normalizeToggleSlots(toggleSlots);
  });
}

async function updateSkillfulSettings(
  scope: SkillfulScope,
  cwd: string,
  projectTrusted: boolean,
  updater: (current: Record<string, unknown>) => void,
): Promise<SkillfulSettings> {
  if (scope === "project" && !projectTrusted) {
    throw new Error("Project skillful settings require a trusted project.");
  }

  const path = settingsPath(scope, cwd);
  // Pi's SDK calls the callback before acquiring a lock for an absent file.
  // Bootstrap only the absent project document with O_EXCL, then re-read under
  // the SDK's same-scope lock. Never replace a concurrently created document.
  if (scope === "global" && !existsSync(path)) throw new Error("Global settings must exist before saving skillful settings.");
  if (scope === "project" && !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    try { writeFileSync(path, "{}\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const manager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: scope === "project" });
  const storage = (manager as unknown as {
    storage?: { withLock(scope: SkillfulScope, fn: (current: string | undefined) => undefined): void };
  }).storage;
  if (typeof storage?.withLock !== "function") throw new Error("SDK settings lock is unavailable.");
  let result: SkillfulSettings | undefined;
  storage.withLock(scope, (current) => {
    if (current === undefined) throw new Error(`${scope} settings disappeared before locking.`);
    const document = JSON.parse(current.replace(/^\uFEFF/, "")) as unknown;
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error(`${scope} settings must be a JSON object.`);
    result = updateDocument(document as PiSettingsDocument, updater);
    const target = realpathSync(path);
    const temporary = mkdtempSync(join(dirname(target), ".skillful-"));
    try {
      if (scope === "project" && Object.keys(document).length === 0 && !lstatSync(path).isSymbolicLink()) rmSync(target);
      else {
        const next = join(temporary, "settings.json");
        writeFileSync(next, `${JSON.stringify(document, null, 2)}\n`, { mode: statSync(target).mode & 0o777 });
        renameSync(next, target);
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    return undefined;
  });
  if (!result) throw new Error("SDK settings lock did not run the update.");
  return result;
}

function updateDocument(
  document: PiSettingsDocument,
  updater: (current: Record<string, unknown>) => void,
): SkillfulSettings {
  if (document.skillful !== undefined && (!document.skillful || typeof document.skillful !== "object" || Array.isArray(document.skillful))) {
    throw new Error("skillful settings must be an object.");
  }
  const existingSkillful =
    document[SKILLFUL_SETTINGS_KEY] && typeof document[SKILLFUL_SETTINGS_KEY] === "object" && !Array.isArray(document[SKILLFUL_SETTINGS_KEY])
      ? (document[SKILLFUL_SETTINGS_KEY] as Record<string, unknown>)
      : {};
  const nextSkillful = { ...existingSkillful };
  updater(nextSkillful);

  if (Object.keys(nextSkillful).length === 0) delete document[SKILLFUL_SETTINGS_KEY];
  else document[SKILLFUL_SETTINGS_KEY] = nextSkillful as Partial<SkillfulSettings>;

  return settingsFromRecord(nextSkillful);
}

export async function updateHiddenSkills(
  scope: SkillfulScope,
  cwd: string,
  updater: (current: string[]) => string[],
  projectTrusted = false,
): Promise<SkillfulSettings> {
  if (scope === "project" && !projectTrusted) {
    throw new Error("Project skillful settings require a trusted project.");
  }

  return updateSkillfulSettings(scope, cwd, projectTrusted, (current) => {
    current.hiddenSkills = normalizeSkillNames(updater(settingsFromRecord(current).hiddenSkills));
  });
}

function settingsFromRecord(value: unknown): SkillfulSettings {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("skillful settings must be an object.");
  const skillful = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  for (const key of ["hiddenSkills", "visibleSkills"]) {
    if (Object.hasOwn(skillful, key) && (!Array.isArray(skillful[key]) || !(skillful[key] as unknown[]).every(item => typeof item === "string"))) throw new Error(`skillful.${key} must be a string array.`);
  }

  return {
    visibility: normalizeVisibility(skillful.visibility),
    visibilityDefaults: normalizeVisibility(skillful.visibilityDefaults, true),
    hiddenSkills: normalizeSkillNames(stringArray(skillful.hiddenSkills)),
    hiddenSkillsDefined: Object.hasOwn(skillful, "hiddenSkills"),
    visibleSkills: normalizeSkillNames(stringArray(skillful.visibleSkills)),
    toggleSlots: normalizeToggleSlots(skillful.toggleSlots),
    toggleSlotsDefined: Object.hasOwn(skillful, "toggleSlots"),
    toggleModifier: normalizeToggleModifier(skillful.toggleModifier),
    toggleModifierDefined: Object.hasOwn(skillful, "toggleModifier"),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function effectiveHiddenSkillSet(scoped: Record<SkillfulScope, SkillfulSettings>): Set<string> {
  return new Set(scoped.project.hiddenSkillsDefined ? scoped.project.hiddenSkills : scoped.global.hiddenSkills);
}

export function normalizeVisibility(value: unknown, defaults = false): SkillVisibilityMap {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill visibility must be an object.");
  const entries = Object.entries(value);
  if (entries.some(([id, choice]) => !id || !(choice === "show" || choice === "hide" || (!defaults && choice === "inherit")))) throw new Error("Invalid skill visibility choice.");
  return Object.fromEntries(entries) as SkillVisibilityMap;
}

/** Modify one identity only, inside the current scope's SDK transaction. */
export async function updateSkillVisibility(
  scope: SkillfulScope, cwd: string, id: string, name: string,
  choice: SkillVisibility, legacyEligible: boolean, projectTrusted = false,
): Promise<SkillfulSettings> {
  if (scope === "project" && !/^(hub:skills\/|project:|agent:|home:)/.test(id)) {
    throw new Error("This external skill has no portable Project identity; use Global instead.");
  }
  return updateSkillfulSettings(scope, cwd, projectTrusted, (current) => {
    if (current.visibility !== undefined && (!current.visibility || typeof current.visibility !== "object" || Array.isArray(current.visibility))) {
      throw new Error("skillful.visibility must be an object.");
    }
    const visibility = { ...(current.visibility as Record<string, unknown> | undefined) };
    const settings = settingsFromRecord(current);
    const legacyApplies = legacyEligible && settings.hiddenSkillsDefined;
    if (choice === "inherit" && !legacyApplies) delete visibility[id];
    else visibility[id] = choice;
    if (Object.keys(visibility).length) current.visibility = visibility;
    else delete current.visibility;
  });
}
