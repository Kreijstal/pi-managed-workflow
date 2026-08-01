import assert from "node:assert/strict";
import test from "node:test";
import registerExtension from "./index.ts";

test("model-callable tool failures reject so Pi records tool errors", async () => {
	const tools = new Map<string, any>();
	registerExtension({
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		on() {},
		appendEntry() {},
	} as any);

	await assert.rejects(
		() => tools.get("agent_status").execute("call", { id: "missing" }, undefined, undefined, {}),
		/Unknown managed agent/,
	);
	await assert.rejects(
		() =>
			tools
				.get("workflow")
				.execute(
					"call",
					{ file: "/tmp/definitely-missing-workflow.json" },
					undefined,
					undefined,
					{ cwd: "/tmp", isProjectTrusted: () => false },
				),
		/Cannot read workflow file/,
	);
});
