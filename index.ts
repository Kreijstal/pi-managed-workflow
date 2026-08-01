/**
 * Persistent managed agents and spec-driven multi-agent workflows.
 *
 * Child agents run as in-process Pi AgentSessions backed by persistent session
 * files. They remain independently addressable until explicitly closed, while
 * workflows can reuse a named child context across sequential steps.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	ManagedAgentManager,
	type ManagedAgentEvent,
	type ManagedAgentReadResult,
	type ManagedAgentStatus,
} from "./managed-agents.ts";
import { runWorkflow, type WorkflowDetails } from "./workflow-engine.ts";

function statusLine(status: ManagedAgentStatus): string {
	const name = status.name ? ` ${status.name}` : "";
	const profile = status.agent ? ` (${status.agent})` : "";
	const pending = status.pendingMessages ? `, ${status.pendingMessages} queued` : "";
	return `${status.id}${name}${profile}: ${status.state}${pending}`;
}

function eventLine(event: ManagedAgentEvent): string {
	return `${event.cursor}. [${event.kind}] ${event.summary}`;
}

function readText(read: ManagedAgentReadResult): string {
	const header = statusLine(read.status);
	const range = `events ${read.oldestCursor}-${read.latestCursor}${read.truncated ? " (earlier events truncated)" : ""}`;
	const events = read.events.length > 0 ? read.events.map(eventLine).join("\n") : "(no new events)";
	return `${header}\n${range}\n${events}`;
}

function toolResult(text: string, details: unknown): AgentToolResult<any> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function throwToolError(error: unknown): never {
	if (error instanceof Error) throw error;
	throw new Error(String(error));
}

function parseIdAndRemainder(args: string): { id?: string; remainder: string } {
	const trimmed = args.trim();
	if (!trimmed) return { remainder: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	return { id: match?.[1], remainder: match?.[2] ?? "" };
}

function registerManagedAgentCommands(pi: ExtensionAPI, manager: ManagedAgentManager): void {
	pi.registerCommand("agents", {
		description: "List persistent managed agents: /agents [all]",
		handler: async (args, ctx) => {
			try {
				const statuses = manager.list(args.trim() === "all");
				ctx.ui.notify(statuses.length > 0 ? statuses.map(statusLine).join("\n") : "No managed agents", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agent-read", {
		description: "Read recent managed-agent events: /agent-read <id>",
		handler: async (args, ctx) => {
			try {
				const id = manager.resolveId(args.trim());
				const status = manager.status(id);
				const read = manager.read(id, Math.max(0, status.latestCursor - 50), 50);
				ctx.ui.notify(readText(read), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agent-send", {
		description: "Send or queue a managed-agent message: /agent-send <id> <message>",
		handler: async (args, ctx) => {
			const { id: reference, remainder } = parseIdAndRemainder(args);
			if (!reference || !remainder) {
				ctx.ui.notify("Usage: /agent-send <id> <message>", "error");
				return;
			}
			try {
				const id = manager.resolveId(reference);
				const result = await manager.send(id, remainder, "followUp");
				ctx.ui.notify(`${result.delivery}: ${statusLine(result.status)}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agent-stop", {
		description: "Interrupt a managed agent but retain its context: /agent-stop <id>",
		handler: async (args, ctx) => {
			try {
				const id = manager.resolveId(args.trim());
				ctx.ui.notify(statusLine(await manager.interrupt(id)), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agent-close", {
		description: "Close a managed agent and retain its transcript: /agent-close <id>",
		handler: async (args, ctx) => {
			try {
				const id = manager.resolveId(args.trim());
				const status = await manager.close(id);
				ctx.ui.notify(`${statusLine(status)}\nTranscript: ${status.sessionFile}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

function registerManagedAgentTools(pi: ExtensionAPI, manager: ManagedAgentManager): void {
	pi.registerTool({
		name: "agent_spawn",
		label: "Agent Spawn",
		description: "Create a persistent, independently addressable Pi agent. An optional task starts asynchronously.",
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Named agent profile" })),
			task: Type.Optional(Type.String({ description: "Initial task to start asynchronously" })),
			name: Type.Optional(Type.String({ description: "Human-readable managed-agent name" })),
			model: Type.Optional(Type.String({ description: "Model override" })),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist" })),
			cwd: Type.Optional(Type.String({ description: "Working directory" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const status = await manager.spawn(
					{ ...params, trustedRoot: ctx.isProjectTrusted() ? ctx.cwd : undefined, origin: { kind: "tool" } },
					ctx.cwd,
				);
				return toolResult(`${statusLine(status)}\nSession: ${status.sessionFile}`, status);
			} catch (error) {
				return throwToolError(error);
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("agent_spawn ")) + theme.fg("accent", args.name ?? args.agent ?? "agent"),
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "agent_send",
		label: "Agent Send",
		description: "Send a new turn to an idle managed agent or queue steering/follow-up work on a running agent.",
		parameters: Type.Object({
			id: Type.String(),
			message: Type.String(),
			delivery: Type.Optional(StringEnum(["steer", "followUp"] as const)),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await manager.send(params.id, params.message, params.delivery ?? "followUp");
				return toolResult(`${result.delivery}: ${statusLine(result.status)}`, result);
			} catch (error) {
				return throwToolError(error);
			}
		},
	});

	pi.registerTool({
		name: "agent_read",
		label: "Agent Read",
		description: "Read normalized managed-agent events newer than a cursor.",
		parameters: Type.Object({
			id: Type.String(),
			after: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 256, default: 50 })),
		}),
		async execute(_toolCallId, params) {
			try {
				const read = manager.read(params.id, params.after ?? 0, params.limit ?? 50);
				return toolResult(readText(read), read);
			} catch (error) {
				return throwToolError(error);
			}
		},
	});

	pi.registerTool({
		name: "agent_status",
		label: "Agent Status",
		description: "Inspect one managed agent without opening a lazily restored child session.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_toolCallId, params) {
			try {
				const status = manager.status(params.id);
				return toolResult(statusLine(status), status);
			} catch (error) {
				return throwToolError(error);
			}
		},
	});

	pi.registerTool({
		name: "agent_wait",
		label: "Agent Wait",
		description: "Wait for a managed agent to settle. Cancelling this wait does not interrupt the child agent.",
		parameters: Type.Object({
			id: Type.String(),
			after: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 256, default: 50 })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		async execute(_toolCallId, params, signal) {
			try {
				const result = await manager.wait(params.id, {
					after: params.after,
					limit: params.limit,
					timeoutMs: params.timeoutMs,
					signal,
				});
				return toolResult(`${result.timedOut ? "Timed out\n" : "Settled\n"}${readText(result)}`, result);
			} catch (error) {
				return throwToolError(error);
			}
		},
	});

	pi.registerTool({
		name: "agent_interrupt",
		label: "Agent Interrupt",
		description: "Clear queued work and abort the active turn while retaining the agent context for later prompts.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_toolCallId, params) {
			try {
				const status = await manager.interrupt(params.id);
				return toolResult(statusLine(status), status);
			} catch (error) {
				return throwToolError(error);
			}
		},
	});

	pi.registerTool({
		name: "agent_list",
		label: "Agent List",
		description: "List persistent managed agents in the current parent Pi session branch.",
		parameters: Type.Object({
			includeClosed: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_toolCallId, params) {
			try {
				const statuses = manager.list(params.includeClosed ?? false);
				return toolResult(statuses.length > 0 ? statuses.map(statusLine).join("\n") : "No managed agents", { agents: statuses });
			} catch (error) {
				return throwToolError(error);
			}
		},
	});

	pi.registerTool({
		name: "agent_close",
		label: "Agent Close",
		description: "Stop and dispose a managed agent without deleting its persistent Pi transcript.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_toolCallId, params) {
			try {
				const status = await manager.close(params.id);
				return toolResult(`${statusLine(status)}\nTranscript retained: ${status.sessionFile}`, status);
			} catch (error) {
				return throwToolError(error);
			}
		},
	});
}

function registerWorkflowSurface(pi: ExtensionAPI, manager: ManagedAgentManager): void {
	pi.registerCommand("workflow", {
		description: "Run a spec-driven workflow from a JSON file: /workflow <file> [args...]",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/);
			const file = parts.shift();
			if (!file) {
				ctx.ui.notify("Usage: /workflow <file.json> [args...]", "error");
				return;
			}
			ctx.ui.notify(`Running workflow ${file}...`, "info");
			const result = await runWorkflow(
				file,
				parts,
				ctx.cwd,
				undefined,
				undefined,
				manager,
				ctx.isProjectTrusted() ? ctx.cwd : undefined,
			);
			const status = result.ok
				? `✓ ${result.steps.length} steps done`
				: result.failedStep
					? `✗ failed at "${result.failedStep}": ${result.error}`
					: `✗ ${result.error}`;
			ctx.ui.notify(`${result.name ?? file}: ${status}`, result.ok ? "info" : "error");
		},
	});

	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description: [
			"Run a spec-driven multi-agent workflow from a JSON definition file.",
			"Steps run in order or concurrently when sharing a parallel group.",
			"Use a step session key to retain one Pi conversation across sequential steps.",
			"{stepname}, {previous}, {$1..$n}, {$@}, and {$ARGUMENTS} substitute outputs and arguments.",
			"Optional per-step fields: agent, session, model, tools, cwd, retries, onFail, output.",
		].join(" "),
		parameters: Type.Object({
			file: Type.String({ description: "Path to the workflow JSON definition" }),
			args: Type.Optional(
				Type.Union(
					[
						Type.String({ description: "Arguments joined with spaces" }),
						Type.Array(Type.String({ description: "Arguments" })),
					],
					{ description: "Arguments substituted into workflow placeholders" },
				),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const args = Array.isArray(params.args) ? params.args : params.args ? params.args.split(/\s+/) : [];
			const result = await runWorkflow(
				params.file,
				args,
				ctx.cwd,
				signal,
				onUpdate,
				manager,
				ctx.isProjectTrusted() ? ctx.cwd : undefined,
			);
			if (result.ok) {
				return toolResult(
					`Workflow "${result.name ?? params.file}" completed: ${result.steps.length} steps. Final output:\n\n${result.finalOutput || "(no output)"}`,
					result,
				);
			}
			throw new Error(
				`Workflow failed${result.failedStep ? ` at step "${result.failedStep}"` : ""}: ${result.error}`,
			);
		},
		renderCall(args, theme) {
			const argumentText = Array.isArray(args.args) ? args.args.join(" ") : (args.args ?? "");
			let text = theme.fg("toolTitle", theme.bold("workflow ")) + theme.fg("accent", args.file || "(no file)");
			if (argumentText) text += theme.fg("dim", ` ${argumentText}`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as WorkflowDetails | undefined;
			if (!details || details.steps.length === 0) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			let text = (details.ok ? theme.fg("success", "✓") : theme.fg("error", "✗")) + " ";
			text += theme.fg("toolTitle", theme.bold(details.name ?? "workflow"));
			text += theme.fg("muted", ` (${details.steps.length} steps)`);
			if (!details.ok && details.error) text += `\n${theme.fg("error", details.error)}`;
			for (const step of details.steps) {
				const icon = step.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const managed = step.managedAgentId ? ` · ${step.managedAgentId.slice(0, 14)}` : "";
				text += `\n${icon} ${theme.fg("accent", step.name)}${theme.fg("muted", ` (${step.agent}${managed})`)}`;
				if (expanded && step.output) {
					text += `\n${theme.fg("toolOutput", step.output.split("\n").slice(0, 15).join("\n"))}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});
}

export default function (pi: ExtensionAPI) {
	const manager = new ManagedAgentManager({
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
	});

	pi.on("session_start", async (_event, ctx) => {
		await manager.restoreFromBranch(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionFile());
	});
	pi.on("session_before_tree", async () => {
		await manager.prepareForTree();
	});
	pi.on("session_tree", async (_event, ctx) => {
		await manager.rebindFromBranch(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionFile());
	});
	pi.on("session_shutdown", async () => {
		await manager.shutdown();
	});

	registerManagedAgentCommands(pi, manager);
	registerManagedAgentTools(pi, manager);
	registerWorkflowSurface(pi, manager);
}
