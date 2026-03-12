# cc-switcher

Use one shared Claude Code base config plus tiny provider overlays, then generate `~/.claude/settings.json` on demand.

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

## Commands

```bash
bun run src/cli.ts list
bun run src/cli.ts current
bun run src/cli.ts new
bun run src/cli.ts use liaobots
bun run src/cli.ts use
bun run src/cli.ts dump liaobots
bun run src/cli.ts validate
```

## Build binary

```bash
bun run build
./dist/ccs list
```

`bun run build` will also install the binary to `~/.local/bin/ccs`.

## Notes

- `settings.base.json` should not contain `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`.
- `new` can create a new profile interactively, or with flags like `--name`, `--base-url`, and `--key`.
- If you specify `--model`, the profile filename will follow the convention `name-model.json`, and the profile will include `env.ANTHROPIC_MODEL` plus `env.ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` all set to that value (provider-side routing).
- Claude Code's top-level `model` is always taken from `settings.base.json` (kept stable, e.g. `opus`).
- `list` prints numbered profiles, and `use` accepts either a profile name or a profile number.
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
