import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import {
	ManagedAgentManager,
	REGISTRY_ENTRY_TYPE,
	type ManagedSessionFactory,
} from "./managed-agents.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

class FakeSession {
	readonly sessionFile = "/tmp/fake-managed-agent.jsonl";
	readonly sessionId = "fake-session";
	readonly messages: any[] = [];
	isIdle = true;
	isStreaming = false;
	isCompacting = false;
	isBashRunning = false;
	isRetrying = false;
	pendingMessageCount = 0;
	steering: string[] = [];
	followUps: string[] = [];
	disposed = false;
	private listeners = new Set<(event: AgentSessionEvent) => void>();
	private active?: ReturnType<typeof deferred<void>>;
	private stats: SessionStats = {
		sessionFile: this.sessionFile,
		sessionId: this.sessionId,
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
	};

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	async prompt(text: string): Promise<void> {
		this.isIdle = false;
		this.isStreaming = true;
		this.stats.userMessages++;
		this.stats.totalMessages++;
		this.messages.push({ role: "user", content: text });
		this.active = deferred<void>();
		return this.active.promise;
	}

	async steer(text: string): Promise<void> {
		this.steering.push(text);
		this.pendingMessageCount++;
	}

	async followUp(text: string): Promise<void> {
		this.followUps.push(text);
		this.pendingMessageCount++;
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const result = { steering: [...this.steering], followUp: [...this.followUps] };
		this.steering = [];
		this.followUps = [];
		this.pendingMessageCount = 0;
		return result;
	}

	async abort(): Promise<void> {
		if (!this.active) return;
		this.finish("", "aborted");
	}

	async waitForIdle(): Promise<void> {
		await this.active?.promise;
	}

	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
	}

	setSessionName(_name: string): void {}

	getSessionStats(): SessionStats {
		return structuredClone(this.stats);
	}

	emitAssistant(text: string, stopReason = "stop", errorMessage?: string): void {
		const message = {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason,
			errorMessage,
		};
		this.messages.push(message);
		this.emit({ type: "message_end", message } as AgentSessionEvent);
	}

	finish(text: string, stopReason = "stop", errorMessage?: string): void {
		if (!this.active) throw new Error("No active prompt");
		this.emitAssistant(text, stopReason, errorMessage);
		this.stats.assistantMessages++;
		this.stats.totalMessages++;
		this.stats.tokens.input += 10;
		this.stats.tokens.output += 5;
		this.stats.tokens.total += 15;
		this.stats.cost += 0.01;
		this.isIdle = true;
		this.isStreaming = false;
		const active = this.active;
		this.active = undefined;
		active.resolve();
	}
}

function registryEntry(state: "idle" | "running" = "idle", nextCursor = 1): any {
	return {
		type: "custom",
		id: "entry",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: REGISTRY_ENTRY_TYPE,
		data: {
			version: 1,
			revision: 1,
			writtenAt: new Date(0).toISOString(),
			agents: [
				{
					id: "agent_test",
					name: "test",
					config: { cwd: "/tmp", tools: ["read"] },
					configFingerprint: "fingerprint",
					state,
					sessionFile: "/tmp/fake-managed-agent.jsonl",
					sessionId: "fake-session",
					hasTranscript: false,
					createdAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
					activityEpoch: 0,
					nextCursor,
				},
			],
		},
	};
}

async function createManager(state: "idle" | "running" = "idle", nextCursor = 1) {
	const session = new FakeSession();
	const snapshots: unknown[] = [];
	const factory: ManagedSessionFactory = {
		create: async () => ({ session }),
		open: async () => ({ session }),
	};
	let now = 0;
	const manager = new ManagedAgentManager({
		appendEntry: (_type, data) => snapshots.push(data),
		sessionFactory: factory,
		now: () => new Date(now++),
		createId: () => "agent_created",
	});
	await manager.restoreFromBranch([registryEntry(state, nextCursor)], "/tmp/parent.jsonl");
	return { manager, session, snapshots };
}

test("restoration normalizes in-flight state and preserves cursor numbering", async () => {
	const { manager, snapshots } = await createManager("running", 40);
	const status = manager.status("agent_test");
	assert.equal(status.state, "idle");
	assert.equal(status.latestCursor, 40);
	assert.equal(manager.read("agent_test", 0).truncated, true);
	assert.ok(snapshots.length > 0);
});

test("send, steer, interrupt, and resume retain one session", async () => {
	const { manager, session } = await createManager();
	const started = await manager.send("agent_test", "first");
	assert.equal(started.delivery, "started");
	assert.equal(started.status.state, "running");

	const steered = await manager.send("agent_test", "redirect", "steer");
	assert.equal(steered.delivery, "steered");
	assert.deepEqual(session.steering, ["redirect"]);

	const interrupted = await manager.interrupt("agent_test");
	assert.equal(interrupted.state, "idle");
	assert.equal(session.pendingMessageCount, 0);

	await manager.send("agent_test", "resume");
	session.finish("done");
	const waited = await manager.wait("agent_test");
	assert.equal(waited.timedOut, false);
	assert.equal(waited.turn?.output, "done");
	assert.equal(manager.status("agent_test").state, "idle");
	assert.equal(session.messages.filter((message) => message.role === "user").length, 2);
});

test("resolved Pi error messages fail the managed turn without stale output", async () => {
	const { manager, session } = await createManager();
	await manager.send("agent_test", "first");
	session.finish("old success");
	await manager.wait("agent_test");

	await manager.send("agent_test", "failing turn");
	session.finish("", "error", "provider rejected request");
	const failed = await manager.wait("agent_test");
	assert.equal(failed.turn?.error, "provider rejected request");
	assert.equal(failed.turn?.output, "");
	assert.equal(failed.status.state, "error");
});

test("turn output survives message-array replacement during compaction", async () => {
	const { manager, session } = await createManager();
	await manager.send("agent_test", "compact");
	session.messages.splice(0, session.messages.length, { role: "compactionSummary", summary: "older context" });
	session.finish("after compaction");
	const settled = await manager.wait("agent_test");
	assert.equal(settled.turn?.output, "after compaction");
	assert.equal(settled.status.state, "idle");
});

test("turn capture uses the final assistant message after compact-and-retry", async () => {
	const { manager, session } = await createManager();
	await manager.send("agent_test", "retry after compaction");
	session.emitAssistant("", "error", "context overflow");
	session.messages.splice(0, session.messages.length, { role: "compactionSummary", summary: "compacted" });
	session.finish("final answer");
	const settled = await manager.wait("agent_test");
	assert.equal(settled.turn?.output, "final answer");
	assert.equal(settled.turn?.error, undefined);
});

test("concurrent idle sends start one turn and queue the other", async () => {
	const { manager, session } = await createManager();
	const [first, second] = await Promise.all([
		manager.send("agent_test", "first"),
		manager.send("agent_test", "second", "followUp"),
	]);
	assert.deepEqual(new Set([first.delivery, second.delivery]), new Set(["started", "queued"]));
	assert.equal(session.followUps.length, 1);
	assert.ok(["first", "second"].includes(session.followUps[0]));
	await manager.interrupt("agent_test");
});

test("event history is cursor-based and bounded", async () => {
	const { manager, session } = await createManager();
	await manager.send("agent_test", "stream");
	for (let index = 0; index < 300; index++) {
		session.emit({
			type: "message_update",
			message: {} as any,
			assistantMessageEvent: { type: "text_delta", delta: String(index) } as any,
		} as AgentSessionEvent);
	}
	const read = manager.read("agent_test", 0, 256);
	assert.equal(read.events.length, 256);
	assert.equal(read.truncated, true);
	assert.ok(read.oldestCursor > 1);
	assert.equal(read.nextAfter, read.events.at(-1)?.cursor);
	await manager.interrupt("agent_test");
});

test("concurrent close and interrupt never resurrect a closed agent", async () => {
	for (const closeFirst of [true, false]) {
		const { manager } = await createManager();
		await manager.send("agent_test", "work");
		if (closeFirst) await Promise.all([manager.close("agent_test"), manager.interrupt("agent_test")]);
		else await Promise.all([manager.interrupt("agent_test"), manager.close("agent_test")]);
		assert.equal(manager.status("agent_test").state, "closed");
	}
});

test("cancelable tree preparation is non-destructive and reserved cursors never repeat", async () => {
	const { manager, session, snapshots } = await createManager();
	await manager.send("agent_test", "stream");
	for (let index = 0; index < 5; index++) {
		session.emit({
			type: "message_update",
			message: {} as any,
			assistantMessageEvent: { type: "text_delta", delta: String(index) } as any,
		} as AgentSessionEvent);
	}
	await manager.prepareForTree();
	const persisted = snapshots.at(-1);
	assert.ok(persisted);
	assert.equal(manager.status("agent_test").state, "running");
	assert.equal(session.disposed, false);

	for (let index = 5; index < 10; index++) {
		session.emit({
			type: "message_update",
			message: {} as any,
			assistantMessageEvent: { type: "text_delta", delta: String(index) } as any,
		} as AgentSessionEvent);
	}
	const observedAfterSnapshot = manager.status("agent_test").latestCursor;

	const restored = new ManagedAgentManager({
		appendEntry() {},
		sessionFactory: { create: async () => ({ session }), open: async () => ({ session }) },
	});
	await restored.restoreFromBranch(
		[
			{
				type: "custom",
				id: "saved",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: REGISTRY_ENTRY_TYPE,
				data: persisted,
			} as any,
		],
		"/tmp/parent.jsonl",
	);
	assert.ok(restored.status("agent_test").latestCursor > observedAfterSnapshot);
	await manager.interrupt("agent_test");
});

test("confirmed tree navigation disposes live children and restores the destination branch", async () => {
	const { manager, session } = await createManager();
	await manager.send("agent_test", "stream");
	await manager.rebindFromBranch([], "/tmp/other-parent.jsonl");
	assert.equal(session.disposed, true);
	assert.deepEqual(manager.list(), []);
});

test("close aborts and disposes without dropping the transcript reference", async () => {
	const { manager, session } = await createManager();
	await manager.send("agent_test", "work");
	const closed = await manager.close("agent_test");
	assert.equal(closed.state, "closed");
	assert.equal(closed.sessionFile, "/tmp/fake-managed-agent.jsonl");
	assert.equal(session.disposed, true);
	await assert.rejects(() => manager.send("agent_test", "again"), /closed/);
});
