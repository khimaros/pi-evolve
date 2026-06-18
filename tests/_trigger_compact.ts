/**
 * test fixture: registers a `/trigger-compact` command that calls
 * `ctx.compact()` synchronously. invoked via `pi -p "/trigger-compact"` so
 * the dispatch happens inside `session.prompt` (NOT after the agent event
 * queue has been disposed by print mode).
 *
 * we can't use a `turn_end` handler in print mode: extension events emit
 * via an async queue, and print mode's `runtimeHost.dispose()` runs as soon
 * as `session.prompt` resolves -- typically before the queued turn_end has
 * reached extensions, which invalidates the ctx.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("trigger-compact", {
		description: "Trigger compaction immediately (test fixture).",
		handler: async (_args, ctx) => {
			// run a single agent turn first so there's something to compact,
			// then call compact(). sendUserMessage queues a follow-up that
			// session.prompt will pick up. but in print mode we drive the
			// turn from the test: the test sends a normal prompt first, then
			// invokes /trigger-compact via a separate -p arg.
			await new Promise<void>((resolve, reject) => {
				ctx.compact({
					onComplete: () => {
						process.stderr.write("[trigger-compact] done\n");
						resolve();
					},
					onError: (e) => {
						process.stderr.write(`[trigger-compact] err: ${e.message}\n`);
						reject(e);
					},
				});
			});
		},
	});
}
