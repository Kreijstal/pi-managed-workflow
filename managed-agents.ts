import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { AgentSessionEvent, ModelRuntime, SessionEntry, SessionStats } from "@earendil-works/pi-coding-agent";
import {
	DefaultResourceLoader,
	ModelRuntime as PiModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	discoverAgents,
	launchConfigFingerprint,
	resolveLaunchLocation,
	resolveManagedAgentLaunchConfig,
	type ManagedAgentLaunchConfig,
	type ResolvedLaunchConfig,
	type ResolveLaunchRequest,
} from "./agent-config.ts";

export const REGISTRY_ENTRY_TYPE = "workflow.managed-agents.registry";
const REGISTRY_VERSION = 1;
const MAX_EVENTS = 256;
const CURSOR_BLOCK_SIZE = 256;
const MAX_EVENT_TEXT = 2_048;
const MAX_EVENT_DATA = 4_096;
const MAX_LAST_OUTPUT = 8_192;

export type ManagedAgentState =
	| "idle"
	| "running"
	| "interrupting"
	| "closing"
	| "closed"
	| "error";

export interface ManagedAgentOrigin {
	kind: "tool" | "command" | "workflow";
	workflowRunId?: string;
	workflowName?: string;
	workflowStep?: string;
	workflowSessionKey?: string;
}

export interface ManagedAgentEvent {
	cursor: number;
	timestamp: string;
	activityEpoch: number;
	kind:
		| "lifecycle"
		| "status"
		| "message_delta"
		| "message_end"
		| "tool_start"
		| "tool_update"
		| "tool_end"
		| "queue"
		| "retry_start"
		| "retry_end"
		| "compaction_start"
		| "compaction_end"
		| "settled"
		| "error";
	summary: string;
	data?: Record<string, unknown>;
}

export interface ManagedAgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface ManagedAgentTurnResult {
	id: string;
	activityEpoch: number;
	output: string;
	stopReason?: string;
	usage: ManagedAgentUsage;
	aborted: boolean;
	error?: string;
}

export interface ManagedAgentStatus {
	id: string;
	name?: string;
	state: ManagedAgentState;
	agent?: string;
	cwd: string;
	model?: string;
	tools: string[];
	sessionFile: string;
	sessionId: string;
	hasTranscript: boolean;
	loaded: boolean;
	isStreaming?: boolean;
	isCompacting?: boolean;
	isBashRunning?: boolean;
	isRetrying?: boolean;
	pendingMessages?: number;
	latestCursor: number;
	createdAt: string;
	updatedAt: string;
	lastStartedAt?: string;
	lastSettledAt?: string;
	lastError?: string;
	lastStopReason?: string;
	lastOutput?: string;
	origin?: ManagedAgentOrigin;
	lease?: { workflowRunId: string; stepName: string };
}

export interface ManagedAgentReadResult {
	status: ManagedAgentStatus;
	events: ManagedAgentEvent[];
	oldestCursor: number;
	latestCursor: number;
	nextAfter: number;
	truncated: boolean;
}

export interface ManagedAgentSendResult {
	id: string;
	delivery: "started" | "steered" | "queued";
	status: ManagedAgentStatus;
}

export interface ManagedAgentWaitResult extends ManagedAgentReadResult {
	timedOut: boolean;
	turn?: ManagedAgentTurnResult;
}

export interface ManagedAgentSpawnRequest extends ResolveLaunchRequest {
	name?: string;
	task?: string;
	origin?: ManagedAgentOrigin;
}

interface ManagedSession {
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly messages: any[];
	readonly isIdle: boolean;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly isBashRunning: boolean;
	readonly isRetrying: boolean;
	readonly pendingMessageCount: number;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	clearQueue(): { steering: string[]; followUp: string[] };
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	dispose(): void;
	setSessionName(name: string): void;
	getSessionStats(): SessionStats;
}

interface SessionOpenResult {
	session: ManagedSession;
	modelFallbackMessage?: string;
}

export interface ManagedSessionFactory {
	create(config: ManagedAgentLaunchConfig, parentSessionFile: string | undefined): Promise<SessionOpenResult>;
	open(config: ManagedAgentLaunchConfig, sessionFile: string): Promise<SessionOpenResult>;
}

export interface ManagedAgentManagerOptions {
	appendEntry: (customType: string, data: unknown) => void;
	sessionFactory?: ManagedSessionFactory;
	now?: () => Date;
	createId?: () => string;
}

interface PersistedManagedAgent {
	id: string;
	name?: string;
	config: ManagedAgentLaunchConfig;
	configFingerprint: string;
	state: ManagedAgentState;
	sessionFile: string;
	sessionId: string;
	hasTranscript: boolean;
	createdAt: string;
	updatedAt: string;
	lastStartedAt?: string;
	lastSettledAt?: string;
	lastError?: string;
	lastStopReason?: string;
	lastOutput?: string;
	origin?: ManagedAgentOrigin;
	activityEpoch: number;
	nextCursor: number;
	reservedThrough: number;
}

interface RegistrySnapshot {
	version: 1;
	revision: number;
	writtenAt: string;
	agents: PersistedManagedAgent[];
}

interface ManagedAgentRecord extends PersistedManagedAgent {
	events: ManagedAgentEvent[];
	session?: ManagedSession;
	openPromise?: Promise<ManagedSession>;
	unsubscribe?: () => void;
	activeTurn?: Promise<ManagedAgentTurnResult>;
	controlTail: Promise<void>;
	listeners: Set<(event: ManagedAgentEvent) => void>;
	lease?: { workflowRunId: string; stepName: string };
	listenerGeneration?: number;
}

function truncateText(value: string, max = MAX_EVENT_TEXT): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}…`;
}

function safePreview(value: unknown, max = MAX_EVENT_DATA): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	} catch {
		text = String(value);
	}
	return truncateText(text, max);
}

function assistantText(message: any): string {
	if (!message || message.role !== "assistant") return "";
	const blocks = Array.isArray(message.content) ? message.content : [];
	return blocks
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("");
}

function usageDelta(before: SessionStats, after: SessionStats): ManagedAgentUsage {
	return {
		input: Math.max(0, after.tokens.input - before.tokens.input),
		output: Math.max(0, after.tokens.output - before.tokens.output),
		cacheRead: Math.max(0, after.tokens.cacheRead - before.tokens.cacheRead),
		cacheWrite: Math.max(0, after.tokens.cacheWrite - before.tokens.cacheWrite),
		cost: Math.max(0, after.cost - before.cost),
		turns: Math.max(0, after.assistantMessages - before.assistantMessages),
	};
}

function isManagedAgentState(value: unknown): value is ManagedAgentState {
	return ["idle", "running", "interrupting", "closing", "closed", "error"].includes(String(value));
}

function isRegistrySnapshot(value: unknown): value is RegistrySnapshot {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RegistrySnapshot>;
	return candidate.version === REGISTRY_VERSION && Array.isArray(candidate.agents);
}

function abortError(): Error {
	const error = new Error("aborted");
	error.name = "AbortError";
	return error;
}

async function waitWithControls<T>(
	promise: Promise<T>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<{ timedOut: boolean; value?: T }> {
	if (signal?.aborted) throw abortError();

	let timer: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	const controls: Promise<{ timedOut: boolean; value?: T }>[] = [
		promise.then((value) => ({ timedOut: false, value })),
	];

	if (timeoutMs !== undefined && timeoutMs >= 0) {
		controls.push(
			new Promise((resolve) => {
				timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
			}),
		);
	}
	if (signal) {
		controls.push(
			new Promise((_, reject) => {
				abortListener = () => reject(abortError());
				signal.addEventListener("abort", abortListener, { once: true });
			}),
		);
	}

	try {
		return await Promise.race(controls);
	} finally {
		if (timer) clearTimeout(timer);
		if (signal && abortListener) signal.removeEventListener("abort", abortListener);
	}
}

class PiManagedSessionFactory implements ManagedSessionFactory {
	private readonly getRuntime: () => Promise<ModelRuntime>;

	constructor(getRuntime: () => Promise<ModelRuntime>) {
		this.getRuntime = getRuntime;
	}

	private async build(
		config: ManagedAgentLaunchConfig,
		sessionManager: SessionManager,
	): Promise<SessionOpenResult> {
		const runtime = await this.getRuntime();
		const model = config.model ? runtime.getModel(config.model.provider, config.model.id) : undefined;
		if (config.model && !model) {
			throw new Error(`Configured model ${config.model.provider}/${config.model.id} is unavailable`);
		}

		const settingsManager = SettingsManager.create(config.cwd, getAgentDir(), {
			projectTrusted: config.projectTrusted,
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: config.cwd,
			agentDir: getAgentDir(),
			settingsManager,
			noExtensions: true,
			systemPrompt: config.systemPrompt,
		});
		await resourceLoader.reload();

		const result = await createAgentSession({
			cwd: config.cwd,
			modelRuntime: runtime,
			...(model ? { model } : {}),
			tools: config.tools,
			resourceLoader,
			settingsManager,
			sessionManager,
		});
		return result;
	}

	async create(config: ManagedAgentLaunchConfig, parentSessionFile: string | undefined): Promise<SessionOpenResult> {
		const sessionManager = SessionManager.create(
			config.cwd,
			undefined,
			parentSessionFile ? { parentSession: parentSessionFile } : undefined,
		);
		return this.build(config, sessionManager);
	}

	async open(config: ManagedAgentLaunchConfig, sessionFile: string): Promise<SessionOpenResult> {
		return this.build(config, SessionManager.open(sessionFile, undefined, config.cwd));
	}
}

export class ManagedAgentManager {
	private readonly appendEntry: (customType: string, data: unknown) => void;
	private readonly sessionFactory: ManagedSessionFactory;
	private readonly now: () => Date;
	private readonly createId: () => string;
	private readonly records = new Map<string, ManagedAgentRecord>();
	private parentSessionFile?: string;
	private revision = 0;
	private accepting = false;
	private ready = false;
	private lifecycleGeneration = 0;
	private shuttingDown?: Promise<void>;
	private runtimePromise?: Promise<ModelRuntime>;

	constructor(options: ManagedAgentManagerOptions) {
		this.appendEntry = options.appendEntry;
		this.sessionFactory = options.sessionFactory ?? new PiManagedSessionFactory(() => this.getRuntime());
		this.now = options.now ?? (() => new Date());
		this.createId = options.createId ?? (() => `agent_${randomUUID()}`);
	}

	private getRuntime(): Promise<ModelRuntime> {
		this.runtimePromise ??= PiModelRuntime.create();
		return this.runtimePromise;
	}

	private timestamp(): string {
		return this.now().toISOString();
	}

	private assertReady(): void {
		if (!this.ready) throw new Error("Managed agents are not ready for this Pi session");
		if (!this.accepting) throw new Error("Managed agents are shutting down or changing parent sessions");
	}

	private serialize(record: ManagedAgentRecord): PersistedManagedAgent {
		return {
			id: record.id,
			name: record.name,
			config: record.config,
			configFingerprint: record.configFingerprint,
			state: record.state,
			sessionFile: record.sessionFile,
			sessionId: record.sessionId,
			hasTranscript: record.hasTranscript,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			lastStartedAt: record.lastStartedAt,
			lastSettledAt: record.lastSettledAt,
			lastError: record.lastError,
			lastStopReason: record.lastStopReason,
			lastOutput: record.lastOutput,
			origin: record.origin,
			activityEpoch: record.activityEpoch,
			nextCursor: record.nextCursor,
			reservedThrough: record.reservedThrough,
		};
	}

	private persist(): void {
		if (!this.ready) return;
		const snapshot: RegistrySnapshot = {
			version: REGISTRY_VERSION,
			revision: ++this.revision,
			writtenAt: this.timestamp(),
			agents: Array.from(this.records.values(), (record) => this.serialize(record)),
		};
		this.appendEntry(REGISTRY_ENTRY_TYPE, snapshot);
	}

	private recordEvent(
		record: ManagedAgentRecord,
		kind: ManagedAgentEvent["kind"],
		summary: string,
		data?: Record<string, unknown>,
	): ManagedAgentEvent {
		if (record.nextCursor > record.reservedThrough) {
			record.reservedThrough = record.nextCursor + CURSOR_BLOCK_SIZE - 1;
			if (this.ready && this.records.has(record.id)) this.persist();
		}
		const event: ManagedAgentEvent = {
			cursor: record.nextCursor++,
			timestamp: this.timestamp(),
			activityEpoch: record.activityEpoch,
			kind,
			summary: truncateText(summary),
			data,
		};
		record.events.push(event);
		if (record.events.length > MAX_EVENTS) record.events.splice(0, record.events.length - MAX_EVENTS);
		for (const listener of record.listeners) {
			try {
				listener(event);
			} catch {
				// Public Pi session listeners are synchronous; never let observers break the child run.
			}
		}
		return event;
	}

	private setState(record: ManagedAgentRecord, state: ManagedAgentState, summary: string): void {
		record.state = state;
		record.updatedAt = this.timestamp();
		this.recordEvent(record, "status", summary, { state });
	}

	private enqueueControl<T>(record: ManagedAgentRecord, operation: () => Promise<T> | T): Promise<T> {
		const next = record.controlTail.then(operation, operation);
		record.controlTail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private createRecord(data: PersistedManagedAgent): ManagedAgentRecord {
		return {
			...data,
			events: [],
			controlTail: Promise.resolve(),
			listeners: new Set(),
		};
	}

	private latestSnapshot(entries: SessionEntry[]): RegistrySnapshot | undefined {
		let latest: RegistrySnapshot | undefined;
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== REGISTRY_ENTRY_TYPE) continue;
			if (isRegistrySnapshot(entry.data)) latest = entry.data;
		}
		return latest;
	}

	async restoreFromBranch(entries: SessionEntry[], parentSessionFile: string | undefined): Promise<void> {
		this.parentSessionFile = parentSessionFile;
		this.records.clear();
		this.lifecycleGeneration++;
		this.ready = true;
		this.accepting = false;

		const snapshot = this.latestSnapshot(entries);
		this.revision = snapshot?.revision ?? 0;
		let normalized = false;
		for (const persisted of snapshot?.agents ?? []) {
			if (!persisted || typeof persisted.id !== "string" || !isManagedAgentState(persisted.state)) continue;
			const config: ManagedAgentLaunchConfig = {
				...persisted.config,
				projectTrusted: persisted.config?.projectTrusted === true,
			};
			const reservedThrough = Math.max(0, Number(persisted.reservedThrough) || 0);
			const record = this.createRecord({
				...persisted,
				config,
				configFingerprint: launchConfigFingerprint(config),
				nextCursor: Math.max(1, Number(persisted.nextCursor) || 1, reservedThrough + 1),
				reservedThrough,
				activityEpoch: Math.max(0, Number(persisted.activityEpoch) || 0),
			});
			if (["running", "interrupting", "closing"].includes(record.state)) {
				record.state = "idle";
				record.updatedAt = this.timestamp();
				normalized = true;
			}
			this.records.set(record.id, record);
			this.recordEvent(record, "lifecycle", "Restored managed agent; no in-flight turn survives Pi restart");
		}

		this.accepting = true;
		if (snapshot && (normalized || snapshot.agents.length > 0)) this.persist();
	}

	private async disposeLiveRecords(persistAfter: boolean): Promise<void> {
		this.accepting = false;
		this.lifecycleGeneration++;
		await Promise.all(
			Array.from(this.records.values(), async (record) => {
				const session = record.session;
				if (!session) return;
				try {
					session.clearQueue();
					await session.abort();
				} catch (error) {
					record.lastError = error instanceof Error ? error.message : String(error);
				} finally {
					record.unsubscribe?.();
					record.unsubscribe = undefined;
					session.dispose();
					record.session = undefined;
					record.openPromise = undefined;
					record.activeTurn = undefined;
					if (!["closed", "error"].includes(record.state)) record.state = "idle";
				}
			}),
		);
		if (persistAfter) this.persist();
	}

	async prepareForTree(): Promise<void> {
		this.assertReady();
		this.persist();
	}

	async rebindFromBranch(entries: SessionEntry[], parentSessionFile: string | undefined): Promise<void> {
		await this.disposeLiveRecords(false);
		await this.restoreFromBranch(entries, parentSessionFile);
	}

	private attachSession(record: ManagedAgentRecord, session: ManagedSession, generation: number): void {
		record.session = session;
		record.sessionFile = session.sessionFile ?? record.sessionFile;
		record.sessionId = session.sessionId;
		record.listenerGeneration = generation;
		record.unsubscribe = session.subscribe((event) => {
			try {
				if (record.listenerGeneration !== generation || this.lifecycleGeneration !== generation) return;
				this.normalizeSessionEvent(record, event);
			} catch (error) {
				record.lastError = error instanceof Error ? error.message : String(error);
			}
		});
	}

	private normalizeSessionEvent(record: ManagedAgentRecord, event: AgentSessionEvent): void {
		const raw = event as any;
		switch (event.type) {
			case "message_update":
				if (raw.assistantMessageEvent?.type === "text_delta") {
					this.recordEvent(record, "message_delta", raw.assistantMessageEvent.delta ?? "");
				}
				break;
			case "message_end": {
				const message = raw.message;
				this.recordEvent(record, "message_end", `Message ended: ${message?.role ?? "unknown"}`, {
					stopReason: message?.stopReason,
				});
				break;
			}
			case "tool_execution_start":
				this.recordEvent(record, "tool_start", `Tool started: ${raw.toolName ?? "unknown"}`, {
					toolCallId: raw.toolCallId,
					args: safePreview(raw.args),
				});
				break;
			case "tool_execution_update":
				this.recordEvent(record, "tool_update", `Tool update: ${raw.toolName ?? "unknown"}`, {
					toolCallId: raw.toolCallId,
					partialResult: safePreview(raw.partialResult),
				});
				break;
			case "tool_execution_end":
				this.recordEvent(record, "tool_end", `Tool ended: ${raw.toolName ?? "unknown"}`, {
					toolCallId: raw.toolCallId,
					isError: raw.isError,
					result: safePreview(raw.result),
				});
				break;
			case "queue_update":
				this.recordEvent(record, "queue", "Queued messages changed", {
					steering: raw.steering?.length ?? 0,
					followUp: raw.followUp?.length ?? 0,
				});
				break;
			case "auto_retry_start":
				this.recordEvent(record, "retry_start", `Retry ${raw.attempt}/${raw.maxAttempts}`, {
					delayMs: raw.delayMs,
					error: truncateText(raw.errorMessage ?? ""),
				});
				break;
			case "auto_retry_end":
				this.recordEvent(record, "retry_end", raw.success ? "Retry succeeded" : "Retry ended", {
					attempt: raw.attempt,
					finalError: truncateText(raw.finalError ?? ""),
				});
				break;
			case "compaction_start":
				this.recordEvent(record, "compaction_start", `Compaction started (${raw.reason})`);
				break;
			case "compaction_end":
				this.recordEvent(record, "compaction_end", `Compaction ended (${raw.reason})`, {
					aborted: raw.aborted,
					willRetry: raw.willRetry,
					error: truncateText(raw.errorMessage ?? ""),
				});
				break;
			case "agent_end":
				this.recordEvent(record, "lifecycle", raw.willRetry ? "Agent turn ended; retry pending" : "Agent turn ended");
				break;
			case "agent_settled":
				this.recordEvent(record, "settled", "Agent settled");
				break;
			case "bash_execution_update":
				this.recordEvent(record, "tool_update", "Bash output", { delta: truncateText(raw.delta ?? "") });
				break;
		}
	}

	private async ensureLiveSession(record: ManagedAgentRecord): Promise<ManagedSession> {
		if (record.session) return record.session;
		if (record.openPromise) return record.openPromise;
		if (record.state === "closed") throw new Error(`Managed agent ${record.id} is closed`);
		if (record.hasTranscript && !fs.existsSync(record.sessionFile)) {
			record.state = "error";
			record.lastError = `Child session file is missing: ${record.sessionFile}`;
			record.updatedAt = this.timestamp();
			this.recordEvent(record, "error", record.lastError);
			this.persist();
			throw new Error(record.lastError);
		}

		const generation = this.lifecycleGeneration;
		const openPromise = this.sessionFactory
			.open(record.config, record.sessionFile)
			.then(({ session, modelFallbackMessage }) => {
				if (
					generation !== this.lifecycleGeneration ||
					record.state === "closing" ||
					record.state === "closed" ||
					!this.accepting
				) {
					session.dispose();
					throw new Error(`Managed agent ${record.id} changed lifecycle while reopening`);
				}
				this.attachSession(record, session, generation);
				if (modelFallbackMessage) {
					this.recordEvent(record, "lifecycle", `Model fallback: ${modelFallbackMessage}`);
				}
				return session;
			})
			.catch((error) => {
				if (record.state !== "closing" && record.state !== "closed") {
					record.state = "error";
					record.lastError = error instanceof Error ? error.message : String(error);
					record.updatedAt = this.timestamp();
					this.recordEvent(record, "error", record.lastError);
					this.persist();
				}
				throw error;
			})
			.finally(() => {
				if (record.openPromise === openPromise) record.openPromise = undefined;
			});
		record.openPromise = openPromise;
		return openPromise;
	}

	private getRecord(id: string): ManagedAgentRecord {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown managed agent "${id}"`);
		return record;
	}

	resolveId(reference: string): string {
		if (!reference.trim()) throw new Error("Managed agent ID is required");
		if (this.records.has(reference)) return reference;
		const matches = Array.from(this.records.keys()).filter((id) => id.startsWith(reference));
		if (matches.length === 0) throw new Error(`Unknown managed agent "${reference}"`);
		if (matches.length > 1) throw new Error(`Ambiguous managed agent prefix "${reference}"`);
		return matches[0];
	}

	async resolveLaunch(request: ResolveLaunchRequest, defaultCwd: string): Promise<ResolvedLaunchConfig> {
		const runtime = await this.getRuntime();
		const location = resolveLaunchLocation(request, defaultCwd);
		const agents = discoverAgents(location.cwd, location.projectTrusted);
		return resolveManagedAgentLaunchConfig({ ...request, cwd: location.cwd }, defaultCwd, agents, runtime);
	}

	async spawn(request: ManagedAgentSpawnRequest, defaultCwd: string): Promise<ManagedAgentStatus> {
		this.assertReady();
		const generation = this.lifecycleGeneration;
		const resolved = await this.resolveLaunch(request, defaultCwd);
		const opened = await this.sessionFactory.create(resolved.config, this.parentSessionFile);
		if (!this.accepting || generation !== this.lifecycleGeneration) {
			opened.session.dispose();
			throw new Error("Parent Pi session changed while creating the managed agent");
		}
		const sessionFile = opened.session.sessionFile;
		if (!sessionFile) {
			opened.session.dispose();
			throw new Error("Persistent child session did not provide a session file");
		}

		let id = this.createId();
		while (this.records.has(id)) id = this.createId();
		const timestamp = this.timestamp();
		const record = this.createRecord({
			id,
			name: request.name,
			config: resolved.config,
			configFingerprint: resolved.fingerprint,
			state: "idle",
			sessionFile,
			sessionId: opened.session.sessionId,
			hasTranscript: false,
			createdAt: timestamp,
			updatedAt: timestamp,
			origin: request.origin,
			activityEpoch: 0,
			nextCursor: 1,
			reservedThrough: 0,
		});
		this.records.set(id, record);
		this.attachSession(record, opened.session, this.lifecycleGeneration);
		opened.session.setSessionName(request.name ?? `Managed ${resolved.config.agentName ?? id.slice(0, 14)}`);
		this.recordEvent(record, "lifecycle", "Managed agent created");
		if (opened.modelFallbackMessage) {
			this.recordEvent(record, "lifecycle", `Model fallback: ${opened.modelFallbackMessage}`);
		}
		this.persist();

		if (request.task) await this.send(id, request.task, "followUp");
		return this.status(id);
	}

	private async beginTurn(
		record: ManagedAgentRecord,
		message: string,
		onEvent?: (event: ManagedAgentEvent) => void,
	): Promise<{ turn: Promise<ManagedAgentTurnResult> }> {
		const session = await this.ensureLiveSession(record);
		let turn!: Promise<ManagedAgentTurnResult>;

		await this.enqueueControl(record, () => {
			if (!["idle", "error"].includes(record.state)) {
				throw new Error(`Managed agent ${record.id} is ${record.state}, not idle`);
			}
			if (!session.isIdle || session.pendingMessageCount > 0) {
				throw new Error(`Managed agent ${record.id} still has active or queued work`);
			}
			const epoch = ++record.activityEpoch;
			const generation = this.lifecycleGeneration;
			record.lastStartedAt = this.timestamp();
			record.lastError = undefined;
			this.setState(record, "running", "Agent turn started");
			if (onEvent) record.listeners.add(onEvent);
			this.persist();
			turn = this.executeTurn(record, session, message, epoch, generation, onEvent);
			record.activeTurn = turn;
		});

		return { turn };
	}

	private async executeTurn(
		record: ManagedAgentRecord,
		session: ManagedSession,
		message: string,
		epoch: number,
		generation: number,
		onEvent?: (event: ManagedAgentEvent) => void,
	): Promise<ManagedAgentTurnResult> {
		const before = session.getSessionStats();
		let assistant: any | undefined;
		const unsubscribeTurnCapture = session.subscribe((event) => {
			try {
				if (event.type === "message_end" && (event as any).message?.role === "assistant") {
					assistant = (event as any).message;
				}
			} catch {
				// Turn capture must never throw into Pi's synchronous event dispatcher.
			}
		});
		let errorMessage: string | undefined;
		try {
			await session.prompt(message);
			await session.waitForIdle();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			unsubscribeTurnCapture();
		}

		const after = session.getSessionStats();
		const output = assistantText(assistant);
		const stopReason = assistant?.stopReason as string | undefined;
		if (!errorMessage && stopReason === "error") {
			errorMessage = assistant?.errorMessage || "Agent turn ended with an error";
		}
		const aborted = stopReason === "aborted" || errorMessage === "aborted";
		const result: ManagedAgentTurnResult = {
			id: record.id,
			activityEpoch: epoch,
			output,
			stopReason,
			usage: usageDelta(before, after),
			aborted,
			error: errorMessage,
		};

		await this.enqueueControl(record, () => {
			if (onEvent) record.listeners.delete(onEvent);
			if (record.activityEpoch === epoch) record.activeTurn = undefined;
			record.hasTranscript = record.hasTranscript || fs.existsSync(record.sessionFile);
			if (epoch !== record.activityEpoch || generation !== this.lifecycleGeneration) return;
			record.lastSettledAt = this.timestamp();
			record.lastOutput = output ? truncateText(output, MAX_LAST_OUTPUT) : record.lastOutput;
			record.lastStopReason = stopReason;
			if (errorMessage && !aborted && record.state === "running") {
				record.lastError = errorMessage;
				this.setState(record, "error", `Agent turn failed: ${errorMessage}`);
			} else if (record.state === "running") {
				this.setState(record, "idle", aborted ? "Agent turn aborted" : "Agent turn settled");
			}
			this.persist();
		});
		return result;
	}

	private async queueMessage(
		record: ManagedAgentRecord,
		message: string,
		delivery: "steer" | "followUp",
	): Promise<ManagedAgentSendResult> {
		const session = await this.ensureLiveSession(record);
		await this.enqueueControl(record, async () => {
			if (record.lease) throw new Error(`Managed agent ${record.id} is leased by workflow step ${record.lease.stepName}`);
			if (record.state !== "running") throw new Error(`Managed agent ${record.id} is no longer running`);
			if (delivery === "steer") await session.steer(message);
			else await session.followUp(message);
			record.updatedAt = this.timestamp();
			this.recordEvent(record, "queue", delivery === "steer" ? "Steering message queued" : "Follow-up message queued");
			this.persist();
		});
		return {
			id: record.id,
			delivery: delivery === "steer" ? "steered" : "queued",
			status: this.status(record.id),
		};
	}

	async send(
		id: string,
		message: string,
		delivery: "steer" | "followUp" = "followUp",
	): Promise<ManagedAgentSendResult> {
		this.assertReady();
		const record = this.getRecord(id);
		if (record.lease) throw new Error(`Managed agent ${id} is leased by workflow step ${record.lease.stepName}`);
		if (["interrupting", "closing", "closed"].includes(record.state)) {
			throw new Error(`Managed agent ${id} is ${record.state}`);
		}
		if (record.state === "running") return this.queueMessage(record, message, delivery);

		try {
			const { turn } = await this.beginTurn(record, message);
			void turn.catch(() => undefined);
			return { id, delivery: "started", status: this.status(id) };
		} catch (error) {
			if (this.status(id).state === "running" && !record.lease) return this.queueMessage(record, message, delivery);
			throw error;
		}
	}

	async runTurn(
		id: string,
		message: string,
		lease: { workflowRunId: string; stepName: string },
		onEvent?: (event: ManagedAgentEvent) => void,
	): Promise<ManagedAgentTurnResult> {
		this.assertReady();
		const record = this.getRecord(id);
		await this.enqueueControl(record, () => {
			if (record.lease) throw new Error(`Managed agent ${id} is already leased by ${record.lease.stepName}`);
			record.lease = lease;
		});
		try {
			const { turn } = await this.beginTurn(record, message, onEvent);
			return await turn;
		} finally {
			await this.enqueueControl(record, () => {
				if (record.lease?.workflowRunId === lease.workflowRunId && record.lease.stepName === lease.stepName) {
					record.lease = undefined;
				}
			});
		}
	}

	status(id: string): ManagedAgentStatus {
		const record = this.getRecord(id);
		const session = record.session;
		return {
			id: record.id,
			name: record.name,
			state: record.state,
			agent: record.config.agentName,
			cwd: record.config.cwd,
			model: record.config.model ? `${record.config.model.provider}/${record.config.model.id}` : undefined,
			tools: [...record.config.tools],
			sessionFile: record.sessionFile,
			sessionId: record.sessionId,
			hasTranscript: record.hasTranscript,
			loaded: Boolean(session),
			isStreaming: session?.isStreaming,
			isCompacting: session?.isCompacting,
			isBashRunning: session?.isBashRunning,
			isRetrying: session?.isRetrying,
			pendingMessages: session?.pendingMessageCount,
			latestCursor: record.nextCursor - 1,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			lastStartedAt: record.lastStartedAt,
			lastSettledAt: record.lastSettledAt,
			lastError: record.lastError,
			lastStopReason: record.lastStopReason,
			lastOutput: record.lastOutput,
			origin: record.origin,
			lease: record.lease,
		};
	}

	configurationFingerprint(id: string): string {
		return this.getRecord(id).configFingerprint;
	}

	list(includeClosed = false): ManagedAgentStatus[] {
		return Array.from(this.records.values())
			.filter((record) => includeClosed || record.state !== "closed")
			.map((record) => this.status(record.id));
	}

	read(id: string, after = 0, limit = 50): ManagedAgentReadResult {
		const record = this.getRecord(id);
		const boundedLimit = Math.max(1, Math.min(MAX_EVENTS, Math.floor(limit)));
		const oldestCursor = record.events[0]?.cursor ?? record.nextCursor;
		const latestCursor = record.nextCursor - 1;
		const events = record.events.filter((event) => event.cursor > after).slice(0, boundedLimit);
		return {
			status: this.status(id),
			events,
			oldestCursor,
			latestCursor,
			nextAfter: events.at(-1)?.cursor ?? after,
			truncated: after < oldestCursor - 1,
		};
	}

	async wait(
		id: string,
		options: { after?: number; limit?: number; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<ManagedAgentWaitResult> {
		this.assertReady();
		const record = this.getRecord(id);
		let turn: ManagedAgentTurnResult | undefined;
		let timedOut = false;

		while (record.activeTurn || record.state === "running" || record.state === "interrupting") {
			const epoch = record.activityEpoch;
			const promise = record.activeTurn ?? this.ensureLiveSession(record).then((session) => session.waitForIdle()).then(() => undefined);
			const waited = await waitWithControls(promise, options.timeoutMs, options.signal);
			if (waited.timedOut) {
				timedOut = true;
				break;
			}
			if (waited.value) turn = waited.value as ManagedAgentTurnResult;
			if (record.activityEpoch === epoch && !record.activeTurn && record.state !== "running" && record.state !== "interrupting") break;
		}

		return { ...this.read(id, options.after, options.limit), timedOut, turn };
	}

	async interrupt(id: string): Promise<ManagedAgentStatus> {
		this.assertReady();
		const record = this.getRecord(id);
		let accepted = false;
		await this.enqueueControl(record, () => {
			if (["closing", "closed", "interrupting"].includes(record.state)) return;
			accepted = true;
			this.setState(record, "interrupting", "Interrupt requested");
			this.persist();
		});
		if (!accepted) return this.status(id);

		const session = record.session ?? (record.activeTurn ? await this.ensureLiveSession(record) : undefined);
		let cleared = { steering: [] as string[], followUp: [] as string[] };
		if (session) {
			cleared = session.clearQueue();
			await session.abort();
		}

		await this.enqueueControl(record, () => {
			if (record.state !== "interrupting") return;
			record.lastStopReason = "aborted";
			this.setState(record, "idle", "Agent interrupted and retained");
			this.recordEvent(record, "queue", "Queued work cleared", {
				steering: cleared.steering.length,
				followUp: cleared.followUp.length,
			});
			this.persist();
		});
		return this.status(id);
	}

	async close(id: string): Promise<ManagedAgentStatus> {
		this.assertReady();
		const record = this.getRecord(id);
		let accepted = false;
		await this.enqueueControl(record, () => {
			if (["closing", "closed"].includes(record.state)) return;
			if (record.lease) throw new Error(`Managed agent ${id} is leased by workflow step ${record.lease.stepName}`);
			accepted = true;
			this.setState(record, "closing", "Closing managed agent");
			this.persist();
		});
		if (!accepted) return this.status(id);

		const session = record.session;
		if (session) {
			session.clearQueue();
			await session.abort();
			record.unsubscribe?.();
			record.unsubscribe = undefined;
			session.dispose();
			record.session = undefined;
		}

		await this.enqueueControl(record, () => {
			if (record.state !== "closing") return;
			record.activeTurn = undefined;
			record.openPromise = undefined;
			this.setState(record, "closed", "Managed agent closed; transcript retained");
			this.persist();
		});
		return this.status(id);
	}

	async shutdown(): Promise<void> {
		if (this.shuttingDown) return this.shuttingDown;
		this.shuttingDown = (async () => {
			await this.disposeLiveRecords(false);
			for (const record of this.records.values()) {
				if (!["closed", "error"].includes(record.state)) record.state = "idle";
				record.updatedAt = this.timestamp();
			}
			this.persist();
			this.ready = false;
		})();
		try {
			await this.shuttingDown;
		} finally {
			this.shuttingDown = undefined;
		}
	}
}
