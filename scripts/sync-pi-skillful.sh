#!/bin/sh
# Fetch upstream into a temporary tree; patch before replacing either managed artifact.
# Offline: --source /path/to/pi-mono (a local Git checkout; never fetched or modified).
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
repo=https://github.com/jvm/pi-mono.git
ref=main
path=packages/pi-skillful
source=
case $# in
  0) ;;
  2) [ "$1" = --source ] || { echo "usage: $0 [--source checkout]" >&2; exit 2; }; source=$2 ;;
  *) echo "usage: $0 [--source checkout]" >&2; exit 2 ;;
esac
mkdir -p "$root/packages" "$root/upstreams"
dest="$root/$path"
meta="$root/upstreams/pi-skillful.json"
lock="$root/packages/.pi-skillful-sync.lock"
mkdir "$lock" || { echo 'pi-skillful sync already running (check stale lock before removing)' >&2; exit 1; }
tmp=
transaction=0
had_dest=0
had_meta=0
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$transaction" = 1 ]; then
    # A failed second rename or interruption restores the previously installed tree.
    rm -rf "$dest"
    if [ "$had_dest" = 1 ]; then mv "$tmp/old" "$dest"; fi
    if [ "$had_meta" = 1 ]; then cp -p "$tmp/old-meta" "$meta"; else rm -f "$meta"; fi
  fi
  [ -z "$tmp" ] || rm -rf "$tmp"
  rmdir "$lock"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
# Same filesystem as destination so all tree moves are renames.
tmp=$(mktemp -d "$root/packages/.pi-skillful-sync.XXXXXX")
if [ -z "$source" ]; then
  # SYNC_PI_SKILLFUL_PROXY is per-command, never changes global Git configuration.
  git -c http.proxy="${SYNC_PI_SKILLFUL_PROXY-}" clone --depth 1 --filter=blob:none --sparse --branch "$ref" "$repo" "$tmp/src"
  git -C "$tmp/src" sparse-checkout set "$path"
  source="$tmp/src"
fi
sha=$(git -C "$source" rev-parse HEAD)
mkdir -p "$tmp/tree/packages"
# Export only tracked upstream files: no node_modules, build output, or local edits.
git -C "$source" archive --output="$tmp/upstream.tar" HEAD "$path"
# Link the upstream security policy instead of copying its example home paths.
tar --exclude="$path/SECURITY.md" -xf "$tmp/upstream.tar" -C "$tmp/tree"
test -f "$tmp/tree/$path/index.ts"
test -f "$tmp/tree/$path/LICENSE"
git init -q "$tmp/tree"
(cd "$tmp/tree" && git apply --check "$root/patches/pi-skillful.patch" && git apply "$root/patches/pi-skillful.patch")
cat > "$tmp/meta" <<META
{
  "repo": "https://github.com/jvm/pi-mono",
  "ref": "$ref",
  "path": "$path",
  "sha": "$sha"
}
META
if [ -d "$dest" ] && diff -qr "$dest" "$tmp/tree/$path" >/dev/null && [ -f "$meta" ] && cmp -s "$meta" "$tmp/meta"; then
  echo "pi-skillful unchanged ($sha)"
  exit 0
fi
if [ -e "$meta" ]; then cp -p "$meta" "$tmp/old-meta"; had_meta=1; fi
# Record rollback intent before moving. Signals are deferred across the first rename.
trap '' HUP INT TERM
if [ -e "$dest" ]; then mv "$dest" "$tmp/old"; had_dest=1; fi
transaction=1
trap 'exit 1' HUP INT TERM
mv "$tmp/tree/$path" "$dest"
mv "$tmp/meta" "$meta"
transaction=0
echo "synced pi-skillful from $sha"
