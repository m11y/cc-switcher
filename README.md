# cc-switcher

Use one shared Claude Code base config plus tiny provider overlays, then generate `~/.claude/settings.json` on demand.

## Install (binary)

Build and install the `ccs` binary to `~/.local/bin/ccs`:

```bash
bun install
bun run build
ccs --help
```

## Layout

```text
~/.claude/
  settings.base.json
  profiles/
    liaobots.json
    liaobots-dedicated.json
    zhipu.json
  settings.json
  settings.switcher.backup.json
  .switcher-state.json
```

## Quick start

```bash
# 1) Initialize from your current ~/.claude/settings.json (creates settings.base.json + profiles/)
ccs init

# 2) Create a provider profile
ccs new --name aliyun --base-url https://example.com/apps/anthropic --key 'sk-...' --model glm-5

# 3) Switch (writes ~/.claude/settings.json atomically, keeps a backup)
ccs use aliyun-glm-5

# 4) Inspect / validate
ccs current
ccs list
ccs validate
```

## Commands

```bash
ccs init [--from <file>] [--force]
ccs new [--name <name>] [--base-url <url>] [--key <token>] [--model <provider-model>] [--force]
ccs list [--json]
ccs current [--json]
ccs use [profile|number] [--dry-run]
ccs rollback
ccs dump <profile> [--raw]
ccs validate [--json]
ccs paths
```

## Dev (run from source)

```bash
bun run src/cli.ts --help
bun run src/cli.ts list
```

## Notes

- `settings.base.json` should not contain `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`.
- `new` can create a new profile interactively, or with flags like `--name`, `--base-url`, and `--key`.
- If you specify `--model`, the profile filename will follow the convention `name-model.json`, and the profile will include `env.ANTHROPIC_MODEL` plus `env.ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` all set to that value (provider-side routing).
- Claude Code's top-level `model` is always taken from `settings.base.json` (kept stable, e.g. `opus`).
- `list` prints numbered profiles, and `use` accepts either a profile name or a profile number.
- Use `--config-dir <dir>` to point to a different Claude config directory (defaults to `~/.claude`).
- Each profile JSON usually only needs:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://...",
    "ANTHROPIC_AUTH_TOKEN": "..."
  }
}
```

- `use` writes `~/.claude/settings.json` atomically and stores the previous file in `~/.claude/settings.switcher.backup.json`.
- Restart Claude Code after switching if hooks or plugin behavior does not refresh immediately.
