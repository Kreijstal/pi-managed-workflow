# pi-managed-workflow

Persistent managed agents and spec-driven multi-agent workflows for [Pi](https://github.com/earendil-works/pi).

`pi-managed-workflow` gives a Pi session a set of independently addressable child conversations. Each child is a real, file-backed Pi `AgentSession` with its own context, status, event stream, queues, tools, model, working directory, and transcript. Child sessions can keep working while the parent continues, accept steering or follow-up messages, be interrupted without losing context, and be restored after Pi restarts.

The same runtime powers JSON workflows with sequential steps, parallel groups, retries, output substitution, and named session reuse.

> [!CAUTION]
> Managed agents use Pi tools. The default tool set includes shell and file-writing tools, so an agent can execute commands and modify files. Restrict `tools` when that capability is not required. Project trust controls Pi's trust policy; it is not an operating-system sandbox.

## Features

- **Persistent child conversations** with stable managed-agent IDs.
- **Asynchronous operation**: spawn or send work, continue using the parent, then read or wait explicitly.
- **Live normalized events** for text, completed messages, tool activity, queues, retries, compaction, errors, and settlement.
- **Cursor-based reading** with bounded history and monotonically advancing cursor reservations.
- **Steering and follow-up queues** while a child is running.
- **Interrupt-as-pause**: clear queued work and abort the active turn while preserving the conversation for a later prompt.
- **Restart restoration** from child JSONL transcripts and a registry stored in the active parent-session branch.
- **Explicit close** that disposes the live session but retains its transcript.
- **Named agent profiles** from Pi's user and trusted project agent directories.
- **Spec-driven workflows** with sequential steps, parallel batches, retries, failure policies, placeholders, named outputs, and streaming progress.
- **Workflow session reuse** so sequential steps can continue one child conversation.
- **Trust containment** based on canonical paths, preventing inherited project trust from escaping through absolute paths, traversal, sibling-prefix tricks, or symlinks.

## Compatibility

- Pi: `@earendil-works/pi-coding-agent` 0.83 or newer
- Node.js: 22.19.0 or newer

The `v0.0.1` release is tested with:

- `@earendil-works/pi-coding-agent` 0.83.0
- Node.js 26.4.0
- npm 12.0.1

Pi APIs are still evolving. Later Pi versions may require compatibility updates.

## Install

Install the pinned release with Pi:

```bash
pi install git:github.com/Kreijstal/pi-managed-workflow@v0.0.1
```

Restart Pi after installation if it is already running. The extension registers its tools and slash commands when a session starts.

To install the current default branch instead of a release:

```bash
pi install git:github.com/Kreijstal/pi-managed-workflow
```

For a local checkout:

```bash
git clone https://github.com/Kreijstal/pi-managed-workflow.git
cd pi-managed-workflow
npm install
pi -e ./index.ts
```

A one-shot local load check is also available:

```bash
npm run smoke
```

## Quick start

Ask Pi to create a child and start a task:

> Spawn a managed agent named `research` with no tools and ask it to summarize the approach. Then wait for it and show me its output.

Pi can use the following model-callable tools.

### `agent_spawn`

Create a persistent child. If `task` is supplied, the first turn starts asynchronously.

```json
{
  "name": "research",
  "agent": "reviewer",
  "task": "Review the proposed design and list correctness risks.",
  "model": "anthropic/claude-opus-5",
  "tools": ["read", "grep", "find", "ls"],
  "cwd": "."
}
```

All fields are optional. Without `tools` or an agent-profile tool list, the extension uses:

```text
read, bash, edit, write, grep, find, ls
```

Use `"tools": []` for a conversation with no tool access.

### `agent_send`

Start a new turn when the child is idle, or deliver work while it is running.

```json
{
  "id": "agent_…",
  "message": "Focus on cancellation races.",
  "delivery": "steer"
}
```

`delivery` may be:

- `steer`: inject work at Pi's next steering boundary.
- `followUp`: queue work to run after the active turn.

If the child is idle, either mode starts a new prompt immediately.

### `agent_read`

Read events newer than a cursor without waiting:

```json
{
  "id": "agent_…",
  "after": 0,
  "limit": 50
}
```

Save the returned `nextAfter` value and pass it as the next `after` cursor. The event ring retains up to 256 recent events. If a reader falls behind, `truncated` is true and `oldestCursor` identifies the first retained event.

Event kinds include:

```text
lifecycle, status, message_delta, message_end,
tool_start, tool_update, tool_end, queue,
retry_start, retry_end, compaction_start, compaction_end,
settled, error
```

### `agent_status`

Inspect one child without forcing a lazily restored session to open:

```json
{ "id": "agent_…" }
```

Status includes lifecycle state, working directory, model, tools, session path, whether the session is loaded, queue/streaming flags, timestamps, latest cursor, last output, last stop reason, and last error.

### `agent_wait`

Wait for authoritative settlement and return events after a cursor:

```json
{
  "id": "agent_…",
  "after": 42,
  "limit": 100,
  "timeoutMs": 120000
}
```

Canceling `agent_wait` stops only the wait. It does not interrupt the child. Use `agent_interrupt` when the child itself should stop.

### `agent_interrupt`

Clear steering/follow-up queues and abort the active turn while retaining context:

```json
{ "id": "agent_…" }
```

A later `agent_send` resumes the same conversation.

### `agent_list`

List children associated with the current parent-session branch:

```json
{ "includeClosed": false }
```

Set `includeClosed` to `true` to include explicitly closed children.

### `agent_close`

Stop and dispose a child while preserving its Pi JSONL transcript:

```json
{ "id": "agent_…" }
```

Closing is explicit and permanent for that managed-agent record. It does not delete the transcript path reported in the result.

## Slash commands

Human-facing commands mirror the most common lifecycle operations:

```text
/agents [all]
/agent-read <id>
/agent-send <id> <message>
/agent-stop <id>
/agent-close <id>
/workflow <file.json> [args...]
```

Examples:

```text
/agents
/agent-read agent_1234
/agent-send agent_1234 Check the retry path too.
/agent-stop agent_1234
/agent-close agent_1234
/workflow workflows/review.json src/index.ts
```

`/agent-read` displays up to 50 recent events. Tool calls offer precise cursor control for incremental consumers.

## Agent profiles

`agent_spawn.agent` and workflow `agent` fields resolve Pi agent profiles. A profile is a Markdown file with frontmatter and a system prompt body:

```markdown
---
name: reviewer
description: Reviews code for correctness and maintainability
tools: read,grep,find,ls
model: anthropic/claude-opus-5
---

Review the requested code carefully. Report concrete findings with file and line references.
```

The extension discovers:

1. User profiles in Pi's user agent directory.
2. Project profiles in the nearest project agent directory when the child is effectively trusted.

Project profiles override user profiles with the same name. Project profile discovery is disabled for untrusted or outside-root child directories.

## Workflows

A workflow is a JSON object with a non-empty `steps` array:

```json
{
  "name": "review-and-summarize",
  "description": "Run independent reviews, then synthesize the results",
  "steps": [
    {
      "name": "correctness",
      "agent": "reviewer",
      "task": "Review {$1} for correctness bugs.",
      "tools": ["read", "grep", "find", "ls"],
      "parallel": "review",
      "output": "correctness_report"
    },
    {
      "name": "maintainability",
      "agent": "reviewer",
      "task": "Review {$1} for maintainability problems.",
      "tools": ["read", "grep", "find", "ls"],
      "parallel": "review",
      "output": "maintainability_report"
    },
    {
      "name": "draft",
      "session": "synthesis",
      "task": "Combine these reports into a prioritized draft:\n\nCorrectness:\n{correctness_report}\n\nMaintainability:\n{maintainability_report}",
      "tools": []
    },
    {
      "name": "finalize",
      "session": "synthesis",
      "task": "Revise your draft into a concise final report. Your previous answer was:\n\n{previous}",
      "tools": []
    }
  ]
}
```

Run it from the parent working directory:

```text
/workflow workflows/review.json src/index.ts
```

Or ask Pi to invoke the model-callable `workflow` tool:

```json
{
  "file": "workflows/review.json",
  "args": ["src/index.ts"]
}
```

Relative workflow paths are searched in this order:

1. Relative to the parent Pi session's working directory.
2. Pi's user `workflows` directory.

### Step fields

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Unique step name. Its output is available as `{name}` unless `output` overrides the key. |
| `task` | yes | Prompt text after placeholder substitution. The extension sends it to the child prefixed with `Task:`. |
| `agent` | no | Named Pi agent profile. |
| `model` | no | Model override, such as `provider/model-id` or an unambiguous model ID/name. |
| `tools` | no | Exact child tool allowlist. Use `[]` for no tools. |
| `cwd` | no | Child working directory, resolved relative to the parent cwd and canonicalized. |
| `session` | no | Logical key for reusing one child conversation across sequential steps. |
| `parallel` | no | Adjacent steps with the same string or number run concurrently as one batch. |
| `retries` | no | Number of retries after the first attempt. Must be a non-negative integer. |
| `onFail` | no | `stop` by default; `continue` preserves the failure and proceeds. |
| `output` | no | Alternate placeholder key for this step's output. |

### Placeholder substitution

Tasks support:

| Placeholder | Value |
| --- | --- |
| `{stepName}` | Output from a completed step named `stepName`, or its custom `output` key. |
| `{previous}` | Output from the most recently completed result. |
| `{$1}` … `{$n}` | Positional workflow arguments. |
| `{$@}` | All workflow arguments joined with spaces. |
| `{$ARGUMENTS}` | Alias for `{$@}`. |

Substitution happens when each batch starts. Steps in the same parallel batch cannot consume one another's output.

### Parallel groups

Adjacent steps with the same `parallel` value execute concurrently. A different group value begins a new batch, and a step without `parallel` is its own sequential batch.

All completed results from a parallel batch are retained, including results from siblings when another sibling fails. After the batch completes, the workflow stops at the first failing step whose `onFail` is not `continue`.

### Retries

`retries` is the number of additional attempts. A step with `"retries": 2` can run up to three times, with a one-second abortable delay between attempts.

- Without `session`, every attempt gets a fresh managed agent.
- With `session`, retries reuse the same conversation.

Attempt agent IDs are included in workflow details for inspection.

### Named session reuse

Sequential steps sharing a `session` key reuse one managed child and therefore its conversation history:

```json
{
  "steps": [
    {
      "name": "investigate",
      "session": "worker",
      "task": "Investigate the issue and remember your evidence.",
      "tools": ["read", "grep", "find", "ls"]
    },
    {
      "name": "report",
      "session": "worker",
      "task": "Using your existing context, write the final report.",
      "tools": ["read", "grep", "find", "ls"]
    }
  ]
}
```

Every use of one session key must resolve to the same agent profile, model, tool list, working directory, trust state, and system prompt. Changing the configuration produces an error. One session key cannot appear twice in the same parallel batch because a single conversation cannot execute two turns concurrently.

Workflow-created children remain managed and inspectable after the workflow finishes. Use `agent_list`, `agent_read`, or `/agents` to inspect them, then close them explicitly when they are no longer needed.

## Lifecycle and persistence semantics

### Completion

An assistant message ending is not always authoritative because Pi may retry, compact, or process queued continuation messages afterward. This extension considers a managed turn complete only after Pi's prompt and idle/settled lifecycle finishes. `agent_wait` observes that authoritative settlement.

### Pause and resume

`agent_interrupt` and `/agent-stop`:

1. Clear queued steering and follow-up messages.
2. Abort the active turn.
3. Keep the child session and transcript.
4. Return the managed agent to an idle state when interruption settles.

Send another message to continue in the same context. This is pause/resume at a turn boundary, not process suspension.

### Restart restoration

The parent Pi session stores versioned managed-agent registry snapshots as custom session entries. Snapshots contain metadata and child session paths, not live JavaScript objects. When the parent session is reopened, children are restored lazily: status inspection does not need to open their child transcripts, while sending or waiting opens the existing Pi session on demand.

### Parent-session branches

Managed-agent membership follows the active parent Pi session branch. Before tree navigation the extension persists metadata but does not interrupt children. After Pi confirms a branch change, live children from the old branch are disposed and the registry from the selected branch is restored.

Event payloads are bounded and are not a durable full event log. Cursor blocks are reserved before use so a cursor observed on a branch is not reused after crashes or branch navigation. The child JSONL transcript remains the durable conversation record.

### Process and filesystem isolation

Managed children are separate Pi conversation contexts, but they run as in-process `AgentSession` objects. They are not separate operating-system processes or containers. They can also share a working tree unless you give them different directories.

Use Git worktrees, containers, virtual machines, and Pi permission controls separately when stronger filesystem, process, credential, or network isolation is required.

## Security and privacy

- **Default tools are powerful.** `bash`, `edit`, and `write` can run commands and mutate files. Prefer a minimal allowlist, especially for untrusted prompts or read-only review work.
- **Trust is contained, not sandboxed.** A child inherits project trust only when its canonical working directory is the trusted parent root or a descendant. Outside paths and symlink escapes are treated as untrusted. A trusted child can still perform all actions allowed by its tools and Pi configuration.
- **Transcripts persist.** Child Pi JSONL session files can contain prompts, model output, source excerpts, file paths, tool names, tool arguments/results, and errors. Apply appropriate filesystem permissions, retention, backup, and deletion policies.
- **Close does not delete.** `agent_close` releases the live child but intentionally retains its transcript.
- **Extensions are disabled in children.** Child sessions are created with extension loading disabled to prevent recursive loading of this extension. Built-in tools and the selected resource/profile configuration remain available.
- **Events are summaries.** Normalized event data is length-bounded and suitable for progress inspection, not as a substitute for the full transcript or an audit log.
- **Models remain fallible.** Review generated commands and changes, use least privilege, and verify outputs before relying on them.

## Project layout

```text
index.ts                 Extension entry point, tools, commands, and rendering
agent-config.ts          Agent discovery, model/tool resolution, trust containment
managed-agents.ts        Persistent managed-agent runtime and normalized events
workflow-engine.ts       Workflow parser, scheduler, retries, and session reuse
*.test.ts                Unit and regression tests
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run smoke
npm run check
```

`npm run check` runs strict TypeScript validation, the complete Node test suite, and a Pi/Jiti extension load smoke test.

The test suite covers, among other behavior:

- Profile discovery and precedence.
- Canonical trust-root containment, traversal, sibling-prefix, and symlink cases.
- Registry restoration and lazy child reopening.
- Send, steer, follow-up, interrupt, resume, close, and lifecycle races.
- Pi error stop reasons and stale-output prevention.
- Threshold compaction and compact-and-retry output capture.
- Bounded event history and cursor non-reuse.
- Non-destructive pre-tree persistence and confirmed tree rebinds.
- Workflow validation, placeholders, parallel grouping, retries, session reuse, cancellation, and result retention.
- Model-callable tool error propagation.

Model-backed smoke checks should use `"tools": []` unless the test specifically needs filesystem behavior. This keeps the smoke focused on conversation lifecycle rather than granting a test agent command execution.

## Contributing

Issues and pull requests are welcome. Before submitting a change:

1. Keep behavior compatible with Pi's current public APIs where practical.
2. Add focused regression tests for lifecycle, persistence, concurrency, or trust changes.
3. Run `npm run check`.
4. Do not commit Pi configuration, credentials, agent profiles, JSONL transcripts, `.env` files, or generated package directories.
5. Document user-visible behavior in this README and `CHANGELOG.md`.

## License

This project is licensed under the [GNU Affero General Public License v3.0 only](LICENSE).

Agent-profile discovery logic includes portions derived from Pi's MIT-licensed bundled subagent example. See [NOTICE](NOTICE) for attribution and the retained MIT notice.
