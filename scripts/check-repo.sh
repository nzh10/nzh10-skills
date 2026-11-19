#!/bin/sh
# Offline, deterministic repository self-check.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
mode=${1:-}

# 1. Shell script syntax checks
for sh_file in \
  "$root/.githooks/"* \
  "$root/scripts/"*.sh \
  "$root/skills/pi-steward/scripts/"*.sh; do
  [ -f "$sh_file" ] || continue
  sh -n "$sh_file"
done

# 2. Managed upstream copies must contain their patches.
for managed in skill-creator pi-skillful; do
  case "$managed" in
    skill-creator) dest=skills/skill-creator ;;
    pi-skillful) dest=packages/pi-skillful ;;
  esac
  if [ -f "$root/patches/$managed.patch" ] && [ -d "$root/$dest" ]; then
    if ! git -C "$root" apply --reverse --check --unsafe-paths "$root/patches/$managed.patch" >/dev/null 2>&1; then
      echo "check-repo: $dest has unpatched drift relative to patches/$managed.patch" >&2
      exit 1
    fi
  fi
done

# 3. Pi configuration/entry points and Node syntax, with explicit TypeScript stripping.
node "$root/scripts/check-pi-node.mjs" "$root"

# 4. Repository JSON and pools privacy/source invariants.
node --input-type=module - "$root" <<'NODE'
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.argv[2];
const HOME_PATH_RE =
  /(?:(?:^|[^A-Za-z0-9_.-])\/(?:home|Users)\/[A-Za-z0-9._-]+|\/mnt\/[A-Za-z]\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:[/\\]+Users[/\\]+[A-Za-z0-9._-]+)/;

function readJson(relPath) {
  const full = path.join(root, relPath);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

if (fs.existsSync(path.join(root, "package.json"))) {
  readJson("package.json");
}
if (fs.existsSync(path.join(root, "upstream.json"))) {
  readJson("upstream.json");
}

const publicId = /^hub:skills\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.md$/;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const visibilityValue = value => value === "show" || value === "hide";
function checkVisibility(map, collected = false) {
  if (map === undefined) return;
  if (!isObject(map)) throw new Error("Skillful visibility must be an object");
  for (const [id, entry] of Object.entries(map)) {
    const valid = collected
      ? isObject(entry) && Object.keys(entry).length === 2 && (entry.base === null || visibilityValue(entry.base)) && visibilityValue(entry.value)
      : visibilityValue(entry);
    if (!publicId.test(id) || !valid) throw new Error("Invalid public Skillful visibility entry");
  }
}
const canon = readJson("canon/settings.canon.json");
checkVisibility(canon?.skillful?.visibility);
const poolsDir = path.join(root, "pools");
if (fs.existsSync(poolsDir)) {
  for (const entry of fs.readdirSync(poolsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const incPath = path.join(poolsDir, entry.name, "incubating.json");
    if (fs.existsSync(incPath)) {
      const rawInc = fs.readFileSync(incPath, "utf8");
      if (HOME_PATH_RE.test(rawInc)) {
        throw new Error(`Home path leak in pools/${entry.name}/incubating.json`);
      }
      const inc = JSON.parse(rawInc);
      checkVisibility(inc?.settings?.skillful?.visibility, true);
      if (inc.machineId && inc.machineId !== entry.name) {
        throw new Error(`machineId mismatch in pools/${entry.name}/incubating.json: ${inc.machineId}`);
      }
      const pkgList = [
        ...(Array.isArray(inc.incubatingPackages) ? inc.incubatingPackages : []),
        ...(Array.isArray(inc.packages) ? inc.packages : []),
      ];
      for (const pkg of pkgList) {
        const src = typeof pkg === "string" ? pkg : pkg?.source;
        if (typeof src !== "string" || (!src.startsWith("npm:") && !src.startsWith("git:"))) {
          throw new Error(`Invalid local/non-portable package source in pools/${entry.name}/incubating.json: ${String(src)}`);
        }
      }
    }
    const envPath = path.join(poolsDir, entry.name, "machine-env.md");
    if (fs.existsSync(envPath)) {
      const txt = fs.readFileSync(envPath, "utf8");
      if (HOME_PATH_RE.test(txt)) {
        throw new Error(`Home path leak in pools/${entry.name}/machine-env.md`);
      }
    }
  }
}

NODE

# 5. Python AST syntax and intra-skill static import verification
if command -v python3 >/dev/null 2>&1 && [ -d "$root/skills" ]; then
  python3 - "$root/skills" <<'PY'
import ast
import sys
from pathlib import Path

skills_root = Path(sys.argv[1])


def collect_exports(py_file: Path) -> tuple[set[str], bool]:
    tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
    names: set[str] = set()
    has_wildcard = False
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    names.add(t.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "*":
                    has_wildcard = True
                else:
                    names.add(alias.asname or alias.name)
    if "__getattr__" in names:
        has_wildcard = True
    return names, has_wildcard


for skill_dir in sorted(p for p in skills_root.iterdir() if p.is_dir()):
    py_files = sorted(skill_dir.rglob("*.py"))
    export_cache: dict[Path, tuple[set[str], bool]] = {}
    for py_file in py_files:
        export_cache[py_file] = collect_exports(py_file)

    for py_file in py_files:
        tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or not node.module:
                continue
            base_dir = py_file.parent if node.level > 0 else skill_dir
            for _ in range(max(0, node.level - 1)):
                base_dir = base_dir.parent
            rel_parts = node.module.split(".")
            mod_file = base_dir.joinpath(*rel_parts).with_suffix(".py")
            pkg_init = base_dir.joinpath(*rel_parts, "__init__.py")
            target = mod_file if mod_file in export_cache else (pkg_init if pkg_init in export_cache else None)
            if target is None:
                # Check if top-level package exists inside skill_dir (catches missing intra-skill modules)
                top_dir = base_dir / rel_parts[0]
                if node.level == 0 and (top_dir.is_dir() or top_dir.with_suffix(".py").is_file()):
                    raise SystemExit(
                        f"check-repo: broken intra-skill module import '{node.module}' in {py_file}:{node.lineno}"
                    )
                continue
            exported, has_wildcard = export_cache[target]
            if has_wildcard:
                continue
            for alias in node.names:
                if alias.name == "*":
                    continue
                submod = target.parent / f"{alias.name}.py"
                subpkg = target.parent / alias.name / "__init__.py"
                if alias.name not in exported and submod not in export_cache and subpkg not in export_cache:
                    raise SystemExit(
                        f"check-repo: missing symbol '{alias.name}' imported from '{node.module}' in {py_file}:{node.lineno}"
                    )
PY
fi

# 6. Portable secret / credential filename / email scan on HEAD when not --fast
if [ "$mode" != "--fast" ] && git -C "$root" rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C "$root" status >/dev/null
  (cd "$root" && "$root/.githooks/no-personal-info" --portable HEAD)
fi
