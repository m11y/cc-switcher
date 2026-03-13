---
description: cc-switcher (ccs) is a Bun-based CLI that switches Claude Code provider profiles by generating ~/.claude/settings.json.
globs: "src/**/*.ts, scripts/**/*.ts, package.json, tsconfig.json, README.md"
alwaysApply: false
---

This repo is a small Bun + TypeScript CLI, compiled into a single binary (`ccs`).

## Non-Negotiables

- Never commit secrets (tokens/keys/base URLs for private gateways, cookies, etc.). The repo is public.
- Do not add any sample config that contains real-looking credentials. Use placeholders like `sk-...`.
- Keep the CLI reversible: `use` must write atomically and keep a backup.
- Keep the tool dependency-light. Prefer built-in Node/Bun APIs.

## Commands (local dev)

```bash
# Typecheck
bun run check

# Run from source
bun run src/cli.ts --help
bun run src/cli.ts list

# Build + install binary to ~/.local/bin/ccs
bun install
bun run build
ccs --help
```

## Code Conventions

- Runtime is Bun, but using `node:*` stdlib modules (fs/path/os) is fine and expected for portability.
- TypeScript is `strict` with `noUncheckedIndexedAccess`; avoid `any` and handle `undefined` explicitly.
- Avoid logging merged configs unredacted. If you must print config, redact secrets (token/key/password/etc).
- When adding new env fields:
  - Profiles are authoritative for provider-specific values under `env`.
  - `settings.base.json` must not include provider `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`.

## Design Notes

- `init` produces `settings.base.json` by removing provider-specific env fields from an existing `settings.json`.
- `new` writes a minimal profile json into `~/.claude/profiles/`.
- `use` merges base + profile and writes `~/.claude/settings.json` atomically.

## What Not To Do

- Don't introduce a web server / frontend tooling (vite/react/etc). This is a CLI repo.
- Don't add heavy frameworks for argument parsing. Keep `parseArgs` simple.
