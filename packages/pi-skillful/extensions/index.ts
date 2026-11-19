import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import inlineSkillInvocation from "../src/extensions/inline-skill-invocation.js";
import progressiveSkills from "../src/extensions/progressive-skills.js";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import skillVisibility from "../src/extensions/skill-visibility.js";
import sessionSkillToggles from "../src/extensions/session-skill-toggles.js";

export default async function piSkillful(pi: ExtensionAPI) {
  await reportInstallTelemetry();

  progressiveSkills(pi);
  inlineSkillInvocation(pi);
  skillVisibility(pi);
  sessionSkillToggles(pi);
}
