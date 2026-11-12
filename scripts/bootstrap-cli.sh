#!/bin/sh
# Cold-start user-space CLI bootstrap & health check (no sudo required).
# Handles bare WSL/Linux/macOS environments where python3, uv, or ntn may be absent.
set -eu

MODE="${1:---check}"
LOCAL_BIN="${HOME}/.local/bin"
PATH="${LOCAL_BIN}:${PATH}"
export PATH

find_cmd() {
  command -v "$1" 2>/dev/null || true
}

check_all() {
  missing=0
  for base_cmd in git node curl; do
    loc=$(find_cmd "$base_cmd")
    if [ -n "$loc" ]; then
      printf '[ok]      %-10s %s\n' "$base_cmd" "$loc"
    else
      printf '[missing] %-10s (required host prerequisite)\n' "$base_cmd"
      missing=1
    fi
  done

  for user_cmd in uv python3 ntn; do
    loc=$(find_cmd "$user_cmd")
    if [ -n "$loc" ]; then
      printf '[ok]      %-10s %s\n' "$user_cmd" "$loc"
    else
      printf '[missing] %-10s (installable via --install into %s)\n' "$user_cmd" "$LOCAL_BIN"
      missing=1
    fi
  done
  return "$missing"
}

install_missing() {
  if [ -z "$(find_cmd curl)" ]; then
    echo "error: curl is required to bootstrap user-space tools." >&2
    exit 1
  fi
  mkdir -p "$LOCAL_BIN"

  if [ -z "$(find_cmd uv)" ]; then
    echo "==> Installing uv to $LOCAL_BIN ..." >&2
    UV_UNMANAGED_INSTALL="$LOCAL_BIN" curl -LsSf https://astral.sh/uv/install.sh | sh
  fi

  if [ -z "$(find_cmd python3)" ]; then
    echo "==> No system python3 found; installing managed Python 3.12 via uv ..." >&2
    uv python install 3.12
    py_bin=$(uv python find 3.12)
    ln -sf "$py_bin" "$LOCAL_BIN/python3"
    ln -sf "$py_bin" "$LOCAL_BIN/python"
  fi

  if [ -z "$(find_cmd ntn)" ]; then
    echo "==> Installing Notion CLI (ntn) to $LOCAL_BIN ..." >&2
    if command -v bash >/dev/null 2>&1; then
      NTN_INSTALL_DIR="$LOCAL_BIN" curl -fsSL https://ntn.dev | bash
    else
      echo "warning: bash is required by https://ntn.dev installer; skipping ntn." >&2
    fi
  fi

  echo "==> Post-install verification:" >&2
  check_all
}

case "$MODE" in
  --check)
    check_all || exit 1
    ;;
  --install)
    install_missing
    ;;
  *)
    echo "Usage: $0 [--check | --install]" >&2
    exit 2
    ;;
esac
