# pi-evolve

self-modifying hook extension for [pi-coding-agent](https://pi.dev). implements [HOOK_PROTOCOL v1](docs/HOOK_PROTOCOL.md) so existing [opencode-evolve](https://github.com/khimaros/opencode-evolve) hook scripts run in pi unchanged.

## installation

```bash
npm install
ln -s "$(pwd)/src/evolve.ts" ~/.pi/agent/extensions/evolve.ts
```

set `EVOLVE_WORKSPACE` to your workspace directory (default: `~/workspace`). `OPENCODE_EVOLVE_WORKSPACE` is honored as a fallback for cross-host workspaces.

## workspace layout

see [HOOK_PROTOCOL.md](docs/HOOK_PROTOCOL.md). same shape as opencode-evolve:

```
$WORKSPACE/
├── config/evolve.jsonc
├── state/evolve.json
├── hooks/                  # executable hook scripts
├── prompts/                # contract prompt files
└── tests/                  # per-hook validation scripts
```

## status

first cut. the lifecycle stages all map to documented pi extension events; see ROADMAP.md for what's wired vs deferred.

## relationship to opencode-evolve

pi-evolve is the second reference implementation of HOOK_PROTOCOL v1. opencode-evolve is the first. both run identical hook scripts. the spec lives in opencode-evolve and is mirrored here via symlink under `docs/`.
