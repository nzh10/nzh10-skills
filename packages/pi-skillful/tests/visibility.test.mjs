import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readScopedSkillfulSettings } from "../.test-dist/src/config.js";
import { publicSkillId, skillVisibilityId, skillIsHidden, scopedSkillChoice } from "../.test-dist/src/visibility.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "skillful-identities-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const cwd = join(root, "project");
function write(path, value) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
function skill(path, source = "auto", origin = "top-level") {
  return { name: "same", sourceInfo: { path, source, origin, scope: "user" } };
}
function hub(path) {
  write(join(root, "agent/machine.json"), { hubRepoPath: path });
  write(join(path, "canon/settings.canon.json"), {});
  write(join(path, "upstreams/pi-skillful.json"), {});
  write(join(path, "skills/demo/SKILL.md"), {});
  return skill(join(path, "skills/demo/SKILL.md"), path, "package");
}

test("public IDs require actual hub package provenance and real skills containment, including cache", () => {
  const loaded = hub(join(root, "hub"));
  assert.equal(publicSkillId(loaded, cwd), "hub:skills/demo/SKILL.md");
  const impostor = hub(join(root, "impostor"));
  write(join(root, "agent/machine.json"), { hubRepoPath: join(root, "hub") });
  assert.equal(publicSkillId(impostor, cwd), undefined, "copied hub-shaped directories are not this repository");
  assert.equal(publicSkillId({ ...loaded, sourceInfo: { ...loaded.sourceInfo, source: "npm:third-party" } }, cwd), undefined);
  assert.equal(publicSkillId(skill(join(root, "hub/skills/demo/SKILL.md"), join(root, "third-party"), "package"), cwd), undefined);
  write(join(root, "outside.md"), {});
  symlinkSync(join(root, "outside.md"), join(root, "hub/skills/escape.md"));
  assert.equal(publicSkillId(skill(join(root, "hub/skills/escape.md"), join(root, "hub"), "package"), cwd), undefined);
  const cached = hub(join(root, "agent/git/github.com/nzh10/nzh10-skills"));
  cached.sourceInfo.source = "git:github.com/nzh10/nzh10-skills@main";
  assert.equal(publicSkillId(cached, cwd), "hub:skills/demo/SKILL.md");
});

test("private IDs separate same-name projects without absolute Project paths", () => {
  const one = skill(join(cwd, ".pi/skills/same/SKILL.md"));
  const two = skill(join(root, "second/.pi/skills/same/SKILL.md"));
  assert.notEqual(skillVisibilityId(one, "global", cwd), skillVisibilityId(two, "global", cwd));
  assert.equal(skillVisibilityId(one, "project", cwd), "project:.pi/skills/same/SKILL.md");
  assert.equal(skillVisibilityId(two, "project", cwd), undefined);
});

test("per-item precedence, explicit equal choices, legacy empty override, inherit and visibleSkills", async () => {
  const loaded = hub(join(root, "precedence-hub"));
  const id = publicSkillId(loaded, cwd);
  const privateSkill = skill(join(cwd, "private/SKILL.md"));
  const projectId = skillVisibilityId(privateSkill, "project", cwd);
  const globalId = skillVisibilityId(privateSkill, "global", cwd);
  write(join(root, "agent/settings.json"), { skillful: { visibilityDefaults: { [id]: "hide" }, hiddenSkills: ["same"], visibility: { [globalId]: "hide" } } });
  write(join(cwd, ".pi/settings.json"), { skillful: { hiddenSkills: [], visibility: { [projectId]: "inherit" } } });
  let scoped = await readScopedSkillfulSettings(cwd, true);
  assert.equal(skillIsHidden(loaded, cwd, scoped), true, "new public resources ignore legacy [] and names");
  assert.equal(skillIsHidden(privateSkill, cwd, scoped), true, "per-item inherit bypasses legacy []");
  delete scoped.project.visibility[projectId];
  assert.equal(skillIsHidden(privateSkill, cwd, scoped), false, "untouched legacy Project [] preserves original replacement semantics");
  scoped.project.visibility[id] = "show";
  assert.equal(skillIsHidden(loaded, cwd, scoped), false);
  scoped.project.visibility[id] = "inherit";
  scoped.global.visibility[id] = "show";
  assert.equal(skillIsHidden(loaded, cwd, scoped), false);
  scoped.global.visibility[id] = "inherit";
  assert.equal(skillIsHidden(loaded, cwd, scoped), true);
  const thirdParty = { ...loaded, sourceInfo: { ...loaded.sourceInfo, source: "npm:third-party" } };
  assert.equal(skillIsHidden(thirdParty, cwd, scoped), false);
  scoped.project.visibleSkills = ["same"];
  scoped.project.hiddenSkillsDefined = false;
  assert.equal(scopedSkillChoice(privateSkill, "project", cwd, scoped), "inherit", "previously unused visibleSkills remains inert");
  scoped = await readScopedSkillfulSettings(cwd, false);
  assert.equal(skillIsHidden(privateSkill, cwd, scoped), true, "untrusted Project ignored");
});

test.after(() => { delete process.env.PI_CODING_AGENT_DIR; rmSync(root, { recursive: true, force: true }); });
