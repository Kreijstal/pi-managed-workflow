import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	discoverAgents,
	resolveLaunchLocation,
	resolveManagedAgentLaunchConfig,
} from "./agent-config.ts";

test("relative child cwd resolves against the parent session cwd", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-root-"));
	await fs.mkdir(path.join(root, "packages", "api"), { recursive: true });
	const runtime = {
		getProviders: () => [],
		getModel: () => undefined,
		getModels: () => [],
	} as any;
	const resolved = resolveManagedAgentLaunchConfig({ cwd: "packages/api" }, root, [], runtime);
	assert.equal(resolved.config.cwd, path.join(root, "packages", "api"));
	assert.equal(resolved.config.projectTrusted, false);
});

test("project trust is contained to the canonical trusted root", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-trusted-root-"));
	const child = path.join(root, "packages", "api");
	await fs.mkdir(child, { recursive: true });
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pi-untrusted-outside-"));
	const siblingPrefix = `${root}-sibling`;
	await fs.mkdir(siblingPrefix);
	const escape = path.join(root, "escape");
	await fs.symlink(outside, escape, "dir");

	assert.equal(resolveLaunchLocation({ cwd: ".", trustedRoot: root }, root).projectTrusted, true);
	assert.equal(resolveLaunchLocation({ cwd: "packages/api", trustedRoot: root }, root).projectTrusted, true);
	assert.equal(resolveLaunchLocation({ cwd: outside, trustedRoot: root }, root).projectTrusted, false);
	assert.equal(
		resolveLaunchLocation({ cwd: path.relative(root, outside), trustedRoot: root }, root).projectTrusted,
		false,
	);
	assert.equal(resolveLaunchLocation({ cwd: siblingPrefix, trustedRoot: root }, root).projectTrusted, false);
	assert.equal(resolveLaunchLocation({ cwd: escape, trustedRoot: root }, root).projectTrusted, false);
	assert.equal(resolveLaunchLocation({ cwd: child }, root).projectTrusted, false);
});

test("project agent profiles are invisible until the effective child project is trusted", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-trust-"));
	const agentsDir = path.join(cwd, ".pi", "agents");
	await fs.mkdir(agentsDir, { recursive: true });
	await fs.writeFile(
		path.join(agentsDir, "project-only.md"),
		"---\nname: project-only\ndescription: project profile\n---\nProject-controlled instructions.\n",
	);
	assert.equal(discoverAgents(cwd, false).some((agent) => agent.name === "project-only"), false);
	assert.equal(discoverAgents(cwd, true).some((agent) => agent.name === "project-only"), true);
});
