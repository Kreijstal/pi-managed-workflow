import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {
	ManagedAgentEvent,
	ManagedAgentManager,
	ManagedAgentStatus,
	ManagedAgentTurnResult,
} from "./managed-agents.ts";

export interface WorkflowStep {
	name: string;
	agent?: string;
	task: string;
	model?: string;
	tools?: string[];
	cwd?: string;
	session?: string;
	parallel?: string | number;
	retries?: number;
	onFail?: "stop" | "continue";
	output?: string;
}

export interface WorkflowDefinition {
	name?: string;
	description?: string;
	steps: WorkflowStep[];
}

export interface StepResult {
	name: string;
	agent: string;
	output: string;
	exitCode: number;
	error?: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
	managedAgentId?: string;
	attemptAgentIds?: string[];
}

export interface WorkflowDetails {
	ok: boolean;
	name?: string;
	steps: StepResult[];
	failedStep?: string;
	error?: string;
	finalOutput?: string;
}

interface StepOutput {
	exitCode: number;
	output: string;
	error?: string;
	usage?: StepResult["usage"];
	managedAgentId?: string;
	attemptAgentIds: string[];
}

interface WorkflowAgentManager {
	resolveLaunch(
		request: { trustedRoot?: string; agent?: string; model?: string; tools?: string[]; cwd?: string },
		defaultCwd: string,
	): Promise<{ fingerprint: string }>;
	spawn(
		request: {
			agent?: string;
			model?: string;
			tools?: string[];
			cwd?: string;
			name?: string;
			origin?: {
				kind: "workflow";
				workflowRunId: string;
				workflowName?: string;
				workflowStep: string;
				workflowSessionKey?: string;
			};
			trustedRoot?: string;
		},
		defaultCwd: string,
	): Promise<ManagedAgentStatus>;
	configurationFingerprint(id: string): string;
	runTurn(
		id: string,
		message: string,
		lease: { workflowRunId: string; stepName: string },
		onEvent?: (event: ManagedAgentEvent) => void,
	): Promise<ManagedAgentTurnResult>;
	interrupt(id: string): Promise<ManagedAgentStatus>;
}

export function substitute(task: string, outputs: Record<string, string>, args: string[]): string {
	let result = task;
	for (const [name, value] of Object.entries(outputs)) {
		result = result.split(`{${name}}`).join(value ?? "");
	}
	result = result.split("{previous}").join(outputs.previous ?? "");
	args.forEach((argument, index) => {
		result = result.split(`{$${index + 1}}`).join(argument);
	});
	result = result.split("{$@}").join(args.join(" "));
	result = result.split("{$ARGUMENTS}").join(args.join(" "));
	return result;
}

export function groupSteps(steps: WorkflowStep[]): WorkflowStep[][] {
	const batches: WorkflowStep[][] = [];
	for (const step of steps) {
		const last = batches.at(-1);
		if (step.parallel === undefined) {
			batches.push([step]);
		} else if (last && last[0].parallel === step.parallel) {
			last.push(step);
		} else {
			batches.push([step]);
		}
	}
	return batches;
}

export function validateWorkflow(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "Workflow definition must be a JSON object";
	const definition = value as Partial<WorkflowDefinition>;
	if (!Array.isArray(definition.steps) || definition.steps.length === 0) return "Workflow has no steps";
	const names = new Set<string>();
	for (const [index, step] of definition.steps.entries()) {
		if (!step || typeof step.name !== "string" || !step.name.trim()) return `Step ${index + 1} has no name`;
		if (names.has(step.name)) return `Duplicate step name "${step.name}"`;
		names.add(step.name);
		if (typeof step.task !== "string" || !step.task.trim()) return `Step "${step.name}" has no task`;
		if (step.retries !== undefined && (!Number.isInteger(step.retries) || step.retries < 0)) {
			return `Step "${step.name}" has invalid retries`;
		}
		if (step.onFail !== undefined && step.onFail !== "stop" && step.onFail !== "continue") {
			return `Step "${step.name}" has invalid onFail`;
		}
		for (const field of ["agent", "model", "cwd", "session", "output"] as const) {
			if (step[field] !== undefined && typeof step[field] !== "string") {
				return `Step "${step.name}" has invalid ${field}`;
			}
		}
		if (step.tools !== undefined && (!Array.isArray(step.tools) || step.tools.some((tool) => typeof tool !== "string"))) {
			return `Step "${step.name}" has invalid tools`;
		}
		if (step.parallel !== undefined && typeof step.parallel !== "string" && typeof step.parallel !== "number") {
			return `Step "${step.name}" has invalid parallel group`;
		}
	}

	for (const batch of groupSteps(definition.steps)) {
		const sessionKeys = new Set<string>();
		for (const step of batch) {
			if (!step.session) continue;
			if (sessionKeys.has(step.session)) {
				return `Parallel batch reuses session key "${step.session}"; one conversation cannot run two turns concurrently`;
			}
			sessionKeys.add(step.session);
		}
	}
	return undefined;
}

export async function resolveWorkflowFile(filePath: string, cwd: string): Promise<string> {
	if (path.isAbsolute(filePath)) return filePath;
	const candidates = [path.resolve(cwd, filePath), path.join(getAgentDir(), "workflows", filePath)];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return candidates[0];
}

function abortError(): Error {
	const error = new Error("aborted");
	error.name = "AbortError";
	return error;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw abortError();
	await new Promise<void>((resolve, reject) => {
		let onAbort: (() => void) | undefined;
		const finish = (error?: Error) => {
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => finish(), milliseconds);
		if (!signal) return;
		onAbort = () => {
			clearTimeout(timer);
			finish(abortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function stepLaunchRequest(
	step: WorkflowStep,
	trustedRoot: string | undefined,
): { trustedRoot?: string; agent?: string; model?: string; tools?: string[]; cwd?: string } {
	return { trustedRoot, agent: step.agent, model: step.model, tools: step.tools, cwd: step.cwd };
}

async function runManagedTurn(
	manager: WorkflowAgentManager,
	id: string,
	task: string,
	workflowRunId: string,
	step: WorkflowStep,
	signal: AbortSignal | undefined,
	onText?: (delta: string) => void,
): Promise<ManagedAgentTurnResult> {
	if (signal?.aborted) {
		await manager.interrupt(id).catch(() => undefined);
		throw abortError();
	}

	let abortListener: (() => void) | undefined;
	if (signal) {
		abortListener = () => {
			void manager.interrupt(id).catch(() => undefined);
		};
		signal.addEventListener("abort", abortListener, { once: true });
	}

	try {
		return await manager.runTurn(
			id,
			`Task: ${task}`,
			{ workflowRunId, stepName: step.name },
			(event) => {
				if (event.kind === "message_delta" && event.summary) onText?.(event.summary);
			},
		);
	} finally {
		if (signal && abortListener) signal.removeEventListener("abort", abortListener);
	}
}

async function runStep(
	manager: WorkflowAgentManager,
	step: WorkflowStep,
	task: string,
	defaultCwd: string,
	workflowRunId: string,
	workflowName: string | undefined,
	trustedRoot: string | undefined,
	sessions: Map<string, { agentId: string; fingerprint: string }>,
	signal: AbortSignal | undefined,
	onText?: (delta: string) => void,
): Promise<StepOutput> {
	const retries = step.retries ?? 0;
	const attemptAgentIds: string[] = [];
	let lastOutput = "";
	let lastError: string | undefined;
	let lastUsage: StepResult["usage"];
	let lastAgentId: string | undefined;

	for (let attempt = 0; attempt <= retries; attempt++) {
		if (signal?.aborted) {
			return {
				exitCode: 1,
				output: lastOutput,
				error: "aborted",
				usage: lastUsage,
				managedAgentId: lastAgentId,
				attemptAgentIds,
			};
		}
		if (attempt > 0) {
			try {
				await abortableDelay(1_000, signal);
			} catch {
				return {
					exitCode: 1,
					output: lastOutput,
					error: "aborted",
					usage: lastUsage,
					managedAgentId: lastAgentId,
					attemptAgentIds,
				};
			}
		}

		try {
			let agentId: string;
			if (step.session) {
				const resolved = await manager.resolveLaunch(stepLaunchRequest(step, trustedRoot), defaultCwd);
				const existing = sessions.get(step.session);
				if (existing) {
					if (existing.fingerprint !== resolved.fingerprint) {
						throw new Error(`Session key "${step.session}" changes agent/model/tools/cwd/system prompt`);
					}
					agentId = existing.agentId;
				} else {
					const status = await manager.spawn(
						{
							...stepLaunchRequest(step, trustedRoot),
							name: `${workflowName ?? "workflow"}:${step.session}`,
							origin: {
								kind: "workflow",
								workflowRunId,
								workflowName,
								workflowStep: step.name,
								workflowSessionKey: step.session,
							},
						},
						defaultCwd,
					);
					agentId = status.id;
					sessions.set(step.session, { agentId, fingerprint: manager.configurationFingerprint(agentId) });
				}
			} else {
				const status = await manager.spawn(
					{
						...stepLaunchRequest(step, trustedRoot),
						name: `${workflowName ?? "workflow"}:${step.name}:attempt-${attempt + 1}`,
						origin: {
							kind: "workflow",
							workflowRunId,
							workflowName,
							workflowStep: step.name,
						},
					},
					defaultCwd,
				);
				agentId = status.id;
			}

			lastAgentId = agentId;
			attemptAgentIds.push(agentId);
			const result = await runManagedTurn(manager, agentId, task, workflowRunId, step, signal, onText);
			lastOutput = result.output;
			lastUsage = result.usage;
			lastError = result.error ?? (result.aborted ? "aborted" : undefined);
			if (!lastError) {
				return {
					exitCode: 0,
					output: lastOutput,
					usage: lastUsage,
					managedAgentId: agentId,
					attemptAgentIds,
				};
			}
			if (result.aborted || signal?.aborted) break;
		} catch (error) {
			lastError = signal?.aborted ? "aborted" : error instanceof Error ? error.message : String(error);
			if (signal?.aborted) break;
		}
	}

	return {
		exitCode: 1,
		output: lastOutput,
		error: lastError ?? "step failed",
		usage: lastUsage,
		managedAgentId: lastAgentId,
		attemptAgentIds,
	};
}

export async function runWorkflow(
	filePath: string,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: AgentToolResult<WorkflowDetails>) => void) | undefined,
	manager: ManagedAgentManager,
	trustedRoot?: string,
): Promise<WorkflowDetails> {
	const resolved = await resolveWorkflowFile(filePath, cwd);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.promises.readFile(resolved, "utf-8"));
	} catch (error) {
		return {
			ok: false,
			steps: [],
			error: `Cannot read workflow file ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const validationError = validateWorkflow(parsed);
	if (validationError) return { ok: false, steps: [], error: validationError };
	const definition = parsed as WorkflowDefinition;

	const workflowRunId = `workflow_${randomUUID()}`;
	const sessions = new Map<string, { agentId: string; fingerprint: string }>();
	const outputs: Record<string, string> = {};
	const results: StepResult[] = [];

	const emit = () => {
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `Workflow "${definition.name ?? resolved}": ${results.length}/${definition.steps.length} steps done`,
				},
			],
			details: { ok: true, name: definition.name, steps: [...results] },
		});
	};

	for (const batch of groupSteps(definition.steps)) {
		if (signal?.aborted) {
			return { ok: false, name: definition.name, steps: results, error: "Workflow aborted" };
		}

		const batchResults = await Promise.all(
			batch.map(async (step) => {
				const task = substitute(step.task, outputs, args);
				let streamed = "";
				const output = await runStep(
					manager,
					step,
					task,
					cwd,
					workflowRunId,
					definition.name,
					trustedRoot,
					sessions,
					signal,
					(delta) => {
						streamed += delta;
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `Step "${step.name}" (${step.agent ?? "?"}): ${streamed.slice(-200)}`,
								},
							],
							details: { ok: true, name: definition.name, steps: [...results] },
						});
					},
				);
				const result: StepResult = {
					name: step.name,
					agent: step.agent ?? "(no agent)",
					output: output.output || streamed,
					exitCode: output.exitCode,
					error: output.error,
					usage: output.usage,
					managedAgentId: output.managedAgentId,
					attemptAgentIds: output.attemptAgentIds,
				};
				return { step, result };
			}),
		);

		for (const { step, result } of batchResults) {
			results.push(result);
			outputs[step.output ?? step.name] = result.output;
			outputs.previous = result.output;
		}
		emit();

		if (signal?.aborted) {
			const aborted = batchResults.find(({ result }) => result.error === "aborted");
			return {
				ok: false,
				name: definition.name,
				steps: results,
				failedStep: aborted?.step.name,
				error: "Workflow aborted",
			};
		}

		const stoppingFailure = batchResults.find(
			({ step, result }) => result.exitCode !== 0 && step.onFail !== "continue",
		);
		if (stoppingFailure) {
			const { step, result } = stoppingFailure;
			return {
				ok: false,
				name: definition.name,
				steps: results,
				failedStep: step.name,
				error: `Step "${step.name}" failed (exit ${result.exitCode})${result.error ? `: ${result.error}` : ""}`,
			};
		}
	}

	if (signal?.aborted) return { ok: false, name: definition.name, steps: results, error: "Workflow aborted" };
	const lastStep = results.at(-1);
	return {
		ok: true,
		name: definition.name,
		steps: results,
		finalOutput: lastStep?.output,
	};
}
