import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type SourceInfo } from "@earendil-works/pi-coding-agent";
import type { SkillfulScope, SkillfulSettings, SkillVisibility } from "./config.js";

export interface VisibilitySkill {
  name: string;
  sourceInfo: SourceInfo;
  disableModelInvocation?: boolean;
}
export type ScopedSettings = Record<SkillfulScope, SkillfulSettings>;

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}
function inside(root: string, path: string): string | undefined {
  const value = relative(root, path);
  return value && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value) ? value.split(sep).join("/") : undefined;
}

function localHubRoots(): Set<string> {
  const roots = new Set<string>();
  try {
    const marker = JSON.parse(readFileSync(join(getAgentDir(), "machine.json"), "utf-8"));
    if (typeof marker.hubRepoPath === "string" && isAbsolute(marker.hubRepoPath) && existsSync(marker.hubRepoPath)) roots.add(canonical(marker.hubRepoPath));
  } catch { /* Missing or invalid machine metadata does not authorize a path. */ }
  // Also recognize a published repository copy when this package is loaded
  // directly from its managed packages/pi-skillful subtree (including tests).
  let directory = dirname(fileURLToPath(import.meta.url));
  while (dirname(directory) !== directory) {
    if (directory.endsWith(`${sep}packages${sep}pi-skillful`)) {
      roots.add(canonical(join(directory, "../..")));
      break;
    }
    directory = dirname(directory);
  }
  return roots;
}

/** A name or a skills/ substring is not package provenance. Both the loaded
 * SourceInfo source and real resource containment must identify this hub. */
export function publicSkillId(skill: VisibilitySkill, cwd: string): string | undefined {
  const info = skill.sourceInfo;
  if (info.origin !== "package" || !existsSync(info.path)) return undefined;
  const source = info.source;
  let root: string;
  if (/^git:(?:https:\/\/)?github\.com\/nzh10\/nzh10-skills(?:\.git)?(?:@[^\s]+)?$/.test(source)) {
    root = canonical(join(info.scope === "project" ? join(cwd, ".pi") : getAgentDir(), "git/github.com/nzh10/nzh10-skills"));
  } else {
    if (!source || /^(npm:|git:|https?:)/.test(source) || source === "auto" || source === "local") return undefined;
    const expanded = source.startsWith("~/") ? join(homedir(), source.slice(2)) : source;
    root = canonical(resolve(info.scope === "project" ? join(cwd, ".pi") : getAgentDir(), expanded));
    if (!localHubRoots().has(root)) return undefined;
  }
  if (!existsSync(join(root, "canon/settings.canon.json")) || !existsSync(join(root, "upstreams/pi-skillful.json"))) return undefined;
  const path = canonical(info.path);
  const resource = inside(root, path);
  if (!resource || !/^skills\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.md$/.test(resource)) return undefined;
  return `hub:${resource}`;
}

export function visibilityEligible(skill: VisibilitySkill, cwd: string): boolean {
  return skill.sourceInfo.origin === "top-level" || publicSkillId(skill, cwd) !== undefined;
}

/** Global local identities never enter the shareable Project document. */
export function skillVisibilityId(skill: VisibilitySkill, scope: SkillfulScope, cwd: string): string | undefined {
  const publicId = publicSkillId(skill, cwd);
  if (publicId) return publicId;
  if (skill.sourceInfo.origin !== "top-level" || !skill.sourceInfo.path) return undefined;
  const path = canonical(skill.sourceInfo.path);
  const projectPath = inside(canonical(cwd), path);
  if (scope === "project" && projectPath) return `project:${projectPath}`;
  if (scope === "global" && skill.sourceInfo.scope === "project") return `file:${path}`;
  const agentPath = inside(canonical(getAgentDir()), path);
  if (agentPath) return `agent:${agentPath}`;
  const homePath = inside(canonical(homedir()), path);
  if (homePath) return `home:${homePath}`;
  return scope === "global" ? `file:${path}` : undefined;
}

function legacyChoice(settings: SkillfulSettings, name: string): SkillVisibility | undefined {
  if (settings.hiddenSkillsDefined) return settings.hiddenSkills.includes(name) ? "hide" : "show";
  return undefined;
}

export function scopedSkillChoice(skill: VisibilitySkill, scope: SkillfulScope, cwd: string, settings: ScopedSettings): SkillVisibility {
  const id = skillVisibilityId(skill, scope, cwd);
  const modern = id ? settings[scope].visibility[id] : undefined;
  return modern ?? (skill.sourceInfo.origin === "top-level" ? legacyChoice(settings[scope], skill.name) : undefined) ?? "inherit";
}

/** Project > Global > steward's canon projection > Pi. 'show' removes only
 * Skillful's restriction: callers never clear disableModelInvocation. */
export function skillIsHidden(skill: VisibilitySkill, cwd: string, settings: ScopedSettings): boolean {
  if (!visibilityEligible(skill, cwd)) return false;
  for (const scope of ["project", "global"] as const) {
    const choice = scopedSkillChoice(skill, scope, cwd, settings);
    if (choice !== "inherit") return choice === "hide";
  }
  const id = skillVisibilityId(skill, "global", cwd);
  return !!id && settings.global.visibilityDefaults[id] === "hide";
}
