#!/bin/sh
# Fetch only skills/skill-creator from anthropics/skills into a temp dir,
# reapply patches/skill-creator.patch, and replace this repo's copy.
# Does not clone upstream into this repo and does not touch GitHub.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
upstream_repo=https://github.com/anthropics/skills.git
upstream_ref=main
upstream_path=skills/skill-creator
dest="$root/skills/skill-creator"
meta="$root/upstream.json"
patch="$root/patches/skill-creator.patch"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git clone --depth 1 --filter=blob:none --sparse --branch "$upstream_ref" "$upstream_repo" "$tmp/src"
git -C "$tmp/src" sparse-checkout set "$upstream_path"
sha=$(git -C "$tmp/src" rev-parse HEAD)
test -f "$tmp/src/$upstream_path/SKILL.md"

if [ -f "$meta" ] && grep -F -q "\"sha\": \"$sha\"" "$meta"; then
  echo "skill-creator already at $sha"
  exit 0
fi

mkdir -p "$tmp/tree/skills"
cp -a "$tmp/src/$upstream_path" "$tmp/tree/skills/skill-creator"
if [ -f "$patch" ]; then
  git apply --directory="$tmp/tree" --unsafe-paths "$patch"
fi
test -f "$tmp/tree/skills/skill-creator/SKILL.md"

rm -rf "$dest"
mkdir -p "$root/skills"
cp -a "$tmp/tree/skills/skill-creator" "$dest"

cat > "$meta" <<EOF
{
  "repo": "https://github.com/anthropics/skills",
  "ref": "$upstream_ref",
  "path": "$upstream_path",
  "sha": "$sha"
}
EOF

echo "synced skill-creator from $sha"
