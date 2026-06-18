# pi-evolve

self-modifying hook extension for [pi-coding-agent](https://pi.dev).
implements the [harness control protocol](https://github.com/khimaros/hcp-spec/)
so existing [opencode-evolve](https://github.com/khimaros/opencode-evolve) hook
scripts run in pi unchanged.

## getting started

prerequisites:

- node.js 20+
- a working pi installation

install as a pi extension:

```bash
pi install npm:@khimaros/pi-evolve
```

or from a source checkout:

```bash
make            # install deps + type-check (no build step)
make install    # install globally from this checkout
```

set `EVOLVE_WORKSPACE` to your workspace directory (default: `~/workspace`).
`OPENCODE_EVOLVE_WORKSPACE` is honored as a fallback for cross-host workspaces.

## workspace layout

same shape as opencode-evolve (the workspace layout below is a host-specific
extension, not part of the hcp protocol itself):

```
$WORKSPACE/
├── config/evolve.jsonc
├── state/evolve.json
├── hooks/                  # executable hook scripts
├── prompts/                # contract prompt files
└── tests/                  # per-hook validation scripts
```

## architecture

```
src/
  extension/   pi extension entry (.ts) -- loads hook scripts, registers tools,
               dispatches lifecycle stages (mutate_request, observe_message,
               before_stop, heartbeat, compacting, before_tool/after_tool,
               execute_tool, recover, format_notification)
tests/         python integration tests (spawn pi with this extension)
examples/      reference hook workspaces
```

pi-evolve is a pure extension with no standalone bin, so there is no build step:
pi loads `src/extension/index.ts` straight from source through its bundled jiti
loader. `make` type-checks it.

## development

```bash
make            # install deps + type-check (tsc, no emit)
make lint       # tsc --noEmit
make test       # type-check + run integration tests
make precommit  # lint + test
make install    # install globally from this checkout
make pack       # npm pack into build/
make publish    # npm publish --access public
make clean      # rm -rf dist build tests/.artifacts
```

## status

first cut. the lifecycle stages all map to documented pi extension events;
see [ROADMAP.md](ROADMAP.md) for what's wired vs deferred.

## relationship to opencode-evolve

pi-evolve is one of three reference implementations of the
[harness control protocol](https://github.com/khimaros/hcp-spec/), alongside
opencode-evolve and airun. all three run identical hook scripts.
