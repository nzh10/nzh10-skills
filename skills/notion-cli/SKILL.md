---
name: notion-cli
description: >-
  Interact with Notion workspaces via the official Notion CLI (ntn): read,
  create, edit, or trash Markdown pages, query databases and multi-source data
  sources, post Markdown comments, upload files, deploy or run Notion workers,
  and call any Notion public API endpoint. Trigger whenever the user mentions
  Notion pages, Notion databases, data sources, Notion comments, Notion workers,
  Notion API, or the ntn CLI, even if they only paste a Notion URL or page ID.
compatibility: Requires the ntn CLI binary (user-space installable without sudo on Linux, WSL, macOS, and Windows).
license: MIT
---

# Notion CLI (`ntn`)

Use the official `ntn` CLI to inspect schemas locally and execute Notion operations cleanly without guessing API payloads.

## 1. Cold-Start & Binary Check (Do This First)

Non-login agent subshells on fresh Linux/WSL hosts often omit `~/.local/bin` from `PATH` or start without `ntn` installed. Before running `ntn` commands:

1. Check binary availability and ensure `~/.local/bin` is on `PATH`:
   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   command -v ntn && ntn --version
   ```
2. If `ntn` is missing, install it into user space (no `sudo` required):
   - **Linux / WSL / macOS**:
     ```bash
     mkdir -p "$HOME/.local/bin"
     curl -fsSL https://ntn.dev | NTN_INSTALL_DIR="$HOME/.local/bin" bash
     ```
   - **Windows (`pwsh`)**:
     ```powershell
     winget install --id Notion.ntn -e
     ```

## 2. Authentication & Keychain Probe Order

1. **Probe active credentials before touching `NOTION_KEYRING`**:
   - If `NOTION_API_TOKEN` is set (`[ -n "${NOTION_API_TOKEN:-}" ]` — never print the token value), `ntn` uses it automatically across `pages`, `datasources`, `api`, `files`, and `workers`.
   - Otherwise run plain `ntn whoami` **first without `NOTION_KEYRING=0`**. On macOS, Windows, and WSL/Linux hosts with an active OS/kernel keyring, `ntn login` stores credentials in the keyring (`~/.config/notion/auth.json` will not exist), so forcing `NOTION_KEYRING=0` hides valid credentials!
   - Only if plain `ntn whoami` fails **and** `[ -f "$HOME/.config/notion/auth.json" ]`, run `NOTION_KEYRING=0 ntn whoami` and `export NOTION_KEYRING=0` for subsequent commands in that shell:
     ```bash
     if [ -n "${NOTION_API_TOKEN:-}" ] || ntn whoami >/dev/null 2>&1; then
       ntn whoami
     elif [ -f "$HOME/.config/notion/auth.json" ] && NOTION_KEYRING=0 ntn whoami >/dev/null 2>&1; then
       export NOTION_KEYRING=0
       ntn whoami
     else
       echo "UNAUTHENTICATED"
     fi
     ```
2. **Interactive login when unauthenticated**: Both `ntn datasources`/`api`/`workers` and `ntn pages` (`0.23.29+`, despite stale `--help` copy) reuse saved `ntn login` workspace credentials. When the probe above prints `UNAUTHENTICATED`, stop and ask the user to run `ntn login --no-browser` (or `NOTION_KEYRING=0 ntn login --no-browser` on stripped headless containers where `ntn login` reports a missing OS keyring) before running live Notion operations.

## 3. Self-Discovery Before Guessing Syntax

`ntn` embeds official endpoint docs and OpenAPI schemas. Inspect them locally instead of guessing field names or subcommands:

- `ntn <command> --help` — verify exact subcommands and flags.
- `ntn api ls` — list every supported public Notion API endpoint.
- `ntn api <path> --help` — show HTTP methods, parameters, and examples for an endpoint.
- `ntn api <path> --spec` — print the reduced OpenAPI schema fragment for request/response payloads.
- `ntn api <path> --docs` — print the full official Markdown documentation for an endpoint.

## 4. Pages (`ntn pages`) & Notion URL ID Extraction

- **Extract the 32-hex / UUID ID from Notion URLs first**: Unlike `ntn datasources query`, **`ntn pages` (`get`/`edit`/`trash`/`--parent`) and `ntn api v1/pages/<id>` reject full `notion.so` / `app.notion.com` URLs with `400 invalid_request_url`**. Always extract the trailing 32-hex ID (or hyphenated UUID) from a pasted URL (e.g. `https://app.notion.com/p/ws/my-page-0123456789abcdef0123456789abcdef?source=copy_link` → `0123456789abcdef0123456789abcdef`) before calling `ntn pages` or `ntn api`.
- Subcommands are **`get`**, **`create`**, **`edit`**, and **`trash`** (there is **no** `ntn pages update` command — use `ntn pages edit` for Markdown body updates, or `ntn api -X PATCH v1/pages/<page-id>` for structured page properties).

**Non-interactive safety rule**: Never invoke `ntn pages create` or `ntn pages edit` without `--content` or stdin redirection (`< file.md`). Calling either command with no content input in a TTY launches `$VISUAL`/`$EDITOR`/`vi` and hangs non-interactive agent execution.

```bash
# Read page Markdown (properties are prepended as YAML frontmatter by default)
ntn pages get <page-id>
ntn pages get <page-id> --json   # inspect raw structure or unknown_block_ids if Markdown is truncated

# Create a page (--parent accepts page:<id>, database:<id>, or data-source:<id>)
ntn pages create --parent page:<page-id> --content $'# Title\n\nBody text.'
ntn pages create --parent data-source:<ds-id> < page.md

# Edit an existing page's Markdown body (replaces the ENTIRE page body; use 'edit', NOT 'update')
ntn pages edit <page-id> --content $'# Updated Heading\n\nUpdated body.'
ntn pages edit <page-id> < updated-page.md

# Move a page to trash
ntn pages trash <page-id>
```

- `ntn pages edit` replaces the **entire** page Markdown body (read `ntn pages get <page-id>` first before modifying, and pass `--allow-deleting-content` only when intentionally deleting child pages/databases; for targeted partial patches, check `ntn api '/v1/pages/{page_id}/markdown' -X PATCH --docs`).
- `create` and `edit` strip a leading YAML frontmatter block automatically so `ntn pages get` output can be piped back in; on `create`, frontmatter `title` sets the page title while other frontmatter keys are ignored.
- To update database row properties, icons, covers, or templates, call `ntn api -X PATCH v1/pages/<page-id> -d '<json>'`.

## 5. Databases & Data Sources (`ntn datasources`)

Use `ntn datasources` to query databases and resolve multi-source databases:

```bash
# Query a database URL, single-source database ID, or data-source ID
ntn datasources query <url-or-id> --limit 50 --json

# Query with a structured JSON filter and pagination cursor
ntn datasources query <url-or-id> \
  --filter '{"property":"Done","checkbox":{"equals":true}}' \
  --start-cursor <cursor> --json

# Resolve a multi-source database ID to its underlying data source IDs first
ntn datasources resolve <database-id> --json
ntn datasources query <resolved-data-source-id> --json
```

## 6. Direct Public API & Comments (`ntn api`)

Method defaults to `GET`, or `POST` when a request body is supplied; override with `-X <METHOD>`.

```bash
# GET with query parameter (==)
ntn api v1/users page_size==100

# POST / PATCH with JSON body (-d '<json>' or -d @payload.json)
ntn api -X PATCH v1/pages/<page-id> -d '{"properties":{"Status":{"status":{"name":"Done"}}}}'

# Create a comment using the native markdown field (prefer over rich_text unless mentions/colors are needed)
ntn api v1/comments -d '{"parent":{"page_id":"<page-id>"},"markdown":"Status update with **bold** and [link](https://example.com)."}'
```

Inline body inputs use `key=string_value` and `key:=raw_json` (for booleans, numbers, arrays, or nested objects). Do not mix `-d`/`--data` with inline `key=value` body inputs in the same command.

## 7. File Uploads (`ntn files`) & Workers (`ntn workers`)

```bash
# Stage local bytes via stdin (multipart upload) or register an external URL
ntn files create < diagram.png
ntn files create --filename diagram.png --content-type image/png < /tmp/blob
ntn files create --external-url https://example.com/diagram.png
ntn files get <upload-id>
ntn files list   # returns first page

# Manage Notion workers (run 'ntn workers --help' for env, runs, oauth, sync, webhooks)
ntn workers availability
ntn workers new my-worker
ntn workers deploy
ntn workers list
ntn workers exec <capability>
```
