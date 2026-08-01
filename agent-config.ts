import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ModelRuntime,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface ManagedAgentLaunchConfig {
	projectTrusted: boolean;
	agentName?: string;
	agentSource?: "user" | "project";
	agentFilePath?: string;
	cwd: string;
	model?: { provider: string; id: string };
	tools: string[];
	systemPrompt?: string;
}

export interface ResolveLaunchRequest {
	trustedRoot?: string;
	agent?: string;
	model?: string;
	tools?: string[];
	cwd?: string;
}

type ResolvedModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export interface ResolvedLaunchConfig {
	config: ManagedAgentLaunchConfig;
	model?: ResolvedModel;
	fingerprint: string;
}

export const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((tool: string) => tool.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, includeProject = false): AgentConfig[] {
	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = includeProject ? findNearestProjectAgentsDir(cwd) : null;
	const byName = new Map<string, AgentConfig>();

	for (const agent of loadAgentsFromDir(userDir, "user")) byName.set(agent.name, agent);
	if (projectDir) {
		for (const agent of loadAgentsFromDir(projectDir, "project")) byName.set(agent.name, agent);
	}

	return Array.from(byName.values());
}

export function resolveModel(runtime: ModelRuntime, name: string): ResolvedModel | undefined {
	const trimmed = name.trim();
	if (!trimmed) return undefined;

	if (trimmed.includes("/")) {
		const slash = trimmed.indexOf("/");
		return runtime.getModel(trimmed.slice(0, slash), trimmed.slice(slash + 1));
	}

	for (const provider of runtime.getProviders()) {
		const exact = runtime.getModel(provider.id, trimmed);
		if (exact) return exact;
	}

	const lower = trimmed.toLowerCase();
	for (const provider of runtime.getProviders()) {
		for (const model of runtime.getModels(provider.id)) {
			if (model.id.toLowerCase() === lower || model.name?.toLowerCase() === lower) return model;
		}
	}

	const fuzzy: ResolvedModel[] = [];
	for (const provider of runtime.getProviders()) {
		for (const model of runtime.getModels(provider.id)) {
			if (model.id.toLowerCase().includes(lower) || model.name?.toLowerCase().includes(lower)) {
				fuzzy.push(model);
			}
		}
	}
	return fuzzy.length === 1 ? fuzzy[0] : undefined;
}

export function launchConfigFingerprint(config: ManagedAgentLaunchConfig): string {
	const stable = JSON.stringify({
		projectTrusted: config.projectTrusted,
		agentName: config.agentName ?? null,
		agentSource: config.agentSource ?? null,
		cwd: config.cwd,
		model: config.model ?? null,
		tools: [...config.tools],
		systemPrompt: config.systemPrompt ?? null,
	});
	return createHash("sha256").update(stable).digest("hex");
}

export function resolveLaunchLocation(
	request: Pick<ResolveLaunchRequest, "cwd" | "trustedRoot">,
	defaultCwd: string,
): { cwd: string; projectTrusted: boolean } {
	const requestedCwd = path.resolve(defaultCwd, request.cwd ?? ".");
	let cwd: string;
	try {
		cwd = fs.realpathSync(requestedCwd);
	} catch {
		throw new Error(`Managed-agent cwd does not exist: ${requestedCwd}`);
	}
	if (!isDirectory(cwd)) throw new Error(`Managed-agent cwd is not a directory: ${cwd}`);

	if (!request.trustedRoot) return { cwd, projectTrusted: false };
	let trustedRoot: string;
	try {
		trustedRoot = fs.realpathSync(path.resolve(request.trustedRoot));
	} catch {
		return { cwd, projectTrusted: false };
	}
	const relative = path.relative(trustedRoot, cwd);
	const projectTrusted = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	return { cwd, projectTrusted };
}

export function resolveManagedAgentLaunchConfig(
	request: ResolveLaunchRequest,
	defaultCwd: string,
	agents: AgentConfig[],
	runtime: ModelRuntime,
): ResolvedLaunchConfig {
	const agent = request.agent ? agents.find((candidate) => candidate.name === request.agent) : undefined;
	if (request.agent && !agent) {
		const available = agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
		throw new Error(`Unknown agent "${request.agent}". Available: ${available}`);
	}

	const requestedModel = request.model ?? agent?.model;
	const model = requestedModel ? resolveModel(runtime, requestedModel) : undefined;
	if (requestedModel && !model) {
		throw new Error(`Unknown or ambiguous model "${requestedModel}"`);
	}

	const location = resolveLaunchLocation(request, defaultCwd);
	const config: ManagedAgentLaunchConfig = {
		projectTrusted: location.projectTrusted,
		agentName: agent?.name,
		agentSource: agent?.source,
		agentFilePath: agent?.filePath,
		cwd: location.cwd,
		model: model ? { provider: model.provider, id: model.id } : undefined,
		tools: [...(request.tools ?? agent?.tools ?? DEFAULT_TOOLS)],
		systemPrompt: agent?.systemPrompt.trim() || undefined,
	};

	return {
		config,
		model,
		fingerprint: launchConfigFingerprint(config),
	};
}
