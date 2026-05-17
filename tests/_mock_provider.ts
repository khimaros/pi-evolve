/**
 * test fixture: registers an OpenAI-completions-compatible "mock" provider
 * pointing at the URL in EVOLVE_TEST_MOCK_BASE_URL. used by
 * pi_integration_test.py to capture the actual LLM HTTP request that pi
 * issues when the evolve extension is loaded.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const baseUrl = process.env.EVOLVE_TEST_MOCK_BASE_URL;
	if (!baseUrl) return;
	pi.registerProvider("mock", {
		baseUrl,
		apiKey: "EVOLVE_TEST_MOCK_API_KEY",
		api: "openai-completions",
		models: [
			{
				id: "mock-model",
				name: "Mock Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 4096,
			},
		],
	});
}
