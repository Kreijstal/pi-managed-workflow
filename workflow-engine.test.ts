import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ManagedAgentManager, ManagedAgentStatus, ManagedAgentTurnResult } from "./managed-agents.ts";
import { runWorkflow, substitute, validateWorkflow, type WorkflowDefinition } from "./workflow-engine.ts";

class FakeWorkflowManager {
	private nextId = 1;
	private fingerprints = new Map<string, string>();
	readonly turns: Array<{ id: string; message: string; stepName: string }> = [];
	readonly interrupted: string[] = [];
	failuresRemaining = 0;

	async resolveLaunch(request: Record<string, unknown>): Promise<{ fingerprint: string }> {
		return { fingerprint: JSON.stringify(request) };
	}

	async spawn(request: Record<string, unknown>): Promise<ManagedAgentStatus> {
		const id = `agent_${this.nextId++}`;
		this.fingerprints.set(
			id,
			JSON.stringify({
				trustedRoot: request.trustedRoot,
				agent: request.agent,
				model: request.model,
				tools: request.tools,
				cwd: request.cwd,
			}),
		);
		return {
			id,
			state: "idle",
			cwd: String(request.cwd ?? "/tmp"),
			tools: (request.tools as string[] | undefined) ?? ["read"],
			sessionFile: `/tmp/${id}.jsonl`,
			sessionId: id,
			hasTranscript: false,
			loaded: true,
			latestCursor: 0,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		};
	}

	configurationFingerprint(id: string): string {
		return this.fingerprints.get(id) ?? "";
	}

	async runTurn(
		id: string,
		message: string,
		lease: { workflowRunId: string; stepName: string },
	): Promise<ManagedAgentTurnResult> {
		this.turns.push({ id, message, stepName: lease.stepName });
		if (this.failuresRemaining > 0) {
			this.failuresRemaining--;
			return {
				id,
				activityEpoch: 1,
				output: "failed",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
				aborted: false,
				error: "expected failure",
			};
		}
		return {
			id,
			activityEpoch: 1,
			output: `out-${this.turns.length}`,
			usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
			aborted: false,
		};
	}

	async interrupt(id: string): Promise<ManagedAgentStatus> {
		this.interrupted.push(id);
		return {
			id,
			state: "idle",
			cwd: "/tmp",
			tools: ["read"],
			sessionFile: `/tmp/${id}.jsonl`,
			sessionId: id,
			hasTranscript: true,
			loaded: true,
			latestCursor: 0,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		};
	}
}

async function writeWorkflow(definition: WorkflowDefinition): Promise<{ dir: string; file: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflow-test-"));
	const file = path.join(dir, "workflow.json");
	await fs.writeFile(file, JSON.stringify(definition));
	return { dir, file };
}

test("placeholder substitution remains compatible", () => {
	assert.equal(
		substitute("{$1}|{$@}|{previous}|{named}", { previous: "prev", named: "value" }, ["one", "two"]),
		"one|one two|prev|value",
	);
});

test("validation rejects JSON primitives and malformed step fields", () => {
	assert.match(validateWorkflow(null) ?? "", /JSON object/);
	assert.match(
		validateWorkflow({ steps: [{ name: "bad", task: "x", tools: "read" }] }) ?? "",
		/invalid tools/,
	);
});

test("validation rejects one session used twice in a parallel batch", () => {
	const error = validateWorkflow({
		steps: [
			{ name: "a", task: "a", session: "same", parallel: 1 },
			{ name: "b", task: "b", session: "same", parallel: 1 },
		],
	});
	assert.match(error ?? "", /cannot run two turns concurrently/);
});

test("sequential workflow steps reuse a named session and its placeholders", async () => {
	const { file } = await writeWorkflow({
		name: "reuse",
		steps: [
			{ name: "first", task: "start", session: "research" },
			{ name: "second", task: "use {previous}", session: "research" },
		],
	});
	const manager = new FakeWorkflowManager();
	const result = await runWorkflow(file, [], "/tmp", undefined, undefined, manager as unknown as ManagedAgentManager);
	assert.equal(result.ok, true);
	assert.equal(manager.turns.length, 2);
	assert.equal(manager.turns[0].id, manager.turns[1].id);
	assert.equal(manager.turns[1].message, "Task: use out-1");
	assert.equal(result.steps[0].managedAgentId, result.steps[1].managedAgentId);
});

test("a retry without a session key gets a fresh managed agent", async () => {
	const { file } = await writeWorkflow({
		name: "retry",
		steps: [{ name: "attempt", task: "try", retries: 1 }],
	});
	const manager = new FakeWorkflowManager();
	manager.failuresRemaining = 1;
	const result = await runWorkflow(file, [], "/tmp", undefined, undefined, manager as unknown as ManagedAgentManager);
	assert.equal(result.ok, true);
	assert.deepEqual(result.steps[0].attemptAgentIds, ["agent_1", "agent_2"]);
	assert.equal(result.steps[0].managedAgentId, "agent_2");
	assert.equal(result.steps[0].usage?.input, 2);
});

test("cancellation overrides onFail continue", async () => {
	const { file } = await writeWorkflow({
		name: "active-cancel",
		steps: [{ name: "cancelled", task: "run", onFail: "continue" }],
	});
	const controller = new AbortController();
	const manager = new FakeWorkflowManager();
	manager.runTurn = async (id) => {
		controller.abort();
		return {
			id,
			activityEpoch: 1,
			output: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			aborted: true,
			error: "aborted",
		};
	};
	const result = await runWorkflow(
		file,
		[],
		"/tmp",
		controller.signal,
		undefined,
		manager as unknown as ManagedAgentManager,
	);
	assert.equal(result.ok, false);
	assert.equal(result.error, "Workflow aborted");
	assert.equal(result.steps.length, 1);
});

test("parallel batch failures retain every completed result", async () => {
	const { file } = await writeWorkflow({
		name: "parallel-results",
		steps: [
			{ name: "fails", task: "a", parallel: 1 },
			{ name: "succeeds", task: "b", parallel: 1 },
		],
	});
	const manager = new FakeWorkflowManager();
	manager.failuresRemaining = 1;
	const result = await runWorkflow(file, [], "/tmp", undefined, undefined, manager as unknown as ManagedAgentManager);
	assert.equal(result.ok, false);
	assert.equal(result.steps.length, 2);
	assert.deepEqual(result.steps.map((step) => step.name), ["fails", "succeeds"]);
});

test("an already-aborted workflow starts no child agents", async () => {
	const { file } = await writeWorkflow({
		name: "cancel",
		steps: [{ name: "never", task: "run" }],
	});
	const controller = new AbortController();
	controller.abort();
	const manager = new FakeWorkflowManager();
	const result = await runWorkflow(
		file,
		[],
		"/tmp",
		controller.signal,
		undefined,
		manager as unknown as ManagedAgentManager,
	);
	assert.equal(result.ok, false);
	assert.equal(manager.turns.length, 0);
});
