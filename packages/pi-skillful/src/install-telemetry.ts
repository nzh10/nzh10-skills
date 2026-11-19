import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "pi-skillful";
const INSTALL_TELEMETRY_ENDPOINT = "https://mocito.dev/api/report-install";
const CI_ENVIRONMENT_VARIABLES = [
  "APPVEYOR",
  "BITBUCKET_BUILD_NUMBER",
  "BUILDKITE",
  "CIRCLECI",
  "CODESPACES",
  "DRONE",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "JENKINS_URL",
  "NETLIFY",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "TRAVIS",
  "VERCEL",
];

interface PiSettingsDocument {
  enableInstallTelemetry?: unknown;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return {};
  }
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function isPresentEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function isInstallTelemetryEnabled(env: NodeJS.ProcessEnv = process.env, settingsPath = join(getAgentDir(), "settings.json")): boolean {
  if (isTruthyEnvFlag(env.CI)) return false;
  if (CI_ENVIRONMENT_VARIABLES.some((name) => isPresentEnvFlag(env[name]))) return false;
  if (isTruthyEnvFlag(env.PI_OFFLINE)) return false;

  const settings = readJsonFile(settingsPath) as PiSettingsDocument;
  if (settings.enableInstallTelemetry === false) return false;
  if (env.PI_TELEMETRY !== undefined) return isTruthyEnvFlag(env.PI_TELEMETRY);
  return true;
}

function getPackageVersion(): string {
  const packageJson = readJsonFile(fileURLToPath(new URL("../package.json", import.meta.url))) as { version?: unknown };
  return typeof packageJson.version === "string" && packageJson.version.length > 0 ? packageJson.version : "0.0.0";
}

export async function reportInstallTelemetry(): Promise<void> {
  if (!isInstallTelemetryEnabled()) return;
  let telemetry: typeof import("@mocito/install-telemetry");
  try {
    telemetry = await import("@mocito/install-telemetry");
  } catch (error) {
    // Local Pi packages have no automatic dependency installation.
    if (error && typeof error === "object" && "code" in error &&
        (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND") &&
        "message" in error && /^Cannot find (?:package|module) ['"]@mocito\/install-telemetry['"]/.test(String(error.message))) return;
    throw error;
  }
  try {
    void telemetry.reportInstallTelemetry({
      endpoint: INSTALL_TELEMETRY_ENDPOINT,
      tool: PACKAGE_NAME,
      version: getPackageVersion(),
      statePath: join(getAgentDir(), "extensions", "skillful-install.json"),
      enabled: true,
    }).catch(() => undefined);
  } catch {
    // Preserve upstream's best-effort reporting without delaying skill registration.
  }
}
