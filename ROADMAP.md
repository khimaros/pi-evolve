# roadmap

## in progress

## todo

- [ ] heartbeat: cleanup modes (`none` / `new` / `archive` / `compact`) and thresholds (count / tokens). session isolation is wired (each heartbeat spawns a fresh in-process `AgentSession` with its own system prompt via `createAgentSession` + `DefaultResourceLoader.systemPrompt`); cleanup-on-threshold semantics are not yet implemented.
- [ ] heartbeat subagent tool surface: the fresh agent session runs with `noExtensions: true` (to prevent recursive heartbeat loading), so hello's `hello_note_*` tools are not available inside heartbeat turns. opencode-evolve heartbeats have full access. options: pass our discovered tools via `customTools` on `createAgentSession`, or pass our extension factory via `extensionFactories` on the loader with a flag suppressing the timer.
- [ ] git auto-init of workspace + auto-commit after tool/heartbeat
- [ ] permissions field passthrough — pi has its own permission system; map `permission.arg` to pi's permission gate (or settle for "*" allow/deny in v1)
- [ ] expand integration test to cover idle continuation, heartbeat, observe_message, tool_before/after, recover (current test asserts on dump-request payload only — doesn't exercise the agent loop)
- [ ] verify all of opencode-evolve's `examples/hello` hooks behave identically under pi-evolve (currently symlinked; pi-evolve passes the same prompts contract through)

## done

- [x] initial scaffold + first cut of `src/evolve.ts` covering discover, mutate_request, observe_message, idle, heartbeat, compacting, tool_before/after, execute_tool, recover, format_notification, builtin tools, prompt contract, composability, actions (send)
- [x] integration test: spawns pi with the extension against a temp workspace, asserts on extension load + hook discovery + tool registration + system-prompt injection
- [x] heartbeat session isolation via `createAgentSession` + `DefaultResourceLoader.systemPrompt` — fresh in-process agent loop per heartbeat with the heartbeat-stage composition as actual system prompt. pattern adapted from `tintinweb/pi-schedule-prompt`'s subagent runner.
- [x] compacting hook integration: `session_before_compact` runs the `compacting` hook, and when it returns a custom `prompt`, computes the compaction summary via the exported `complete()` API (modeled on `pi-coding-agent/examples/extensions/custom-compaction.ts`) and returns it as a pre-computed `CompactionResult`.
- [x] e2e parity with opencode-evolve's main scenario: build request system-prompt fidelity (preamble + chat verbatim, env block, heartbeat stage exclusion), tool schema fidelity (enum, optional, every param has a description), heartbeat request content (preamble + heartbeat stage, chat exclusion, [heartbeat] prefix, fresh session)
- [x] compaction integration test: triggered via a `/trigger-compact` slash command (registered by a test fixture extension and dispatched by `pi -p "hello" "/trigger-compact"`) so `ctx.compact()` runs synchronously inside `session.prompt`. a `turn_end`-driven trigger doesn't work in print mode: extension events fire through an async queue and `runtimeHost.dispose()` runs as soon as `session.prompt` resolves, often invalidating the ctx before queued `turn_end` events reach extensions.
