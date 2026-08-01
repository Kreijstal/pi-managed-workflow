# Changelog

All notable changes to this project are documented here.

## [0.0.1] - 2026-08-01

### Added

- Persistent, independently addressable Pi child sessions with stable managed-agent IDs.
- Model-callable tools for spawning, sending, reading, inspecting, waiting, interrupting, listing, and closing agents.
- Slash commands for interactive agent inspection and lifecycle control.
- Cursor-based bounded event streams for messages, tools, queues, retries, compaction, and lifecycle changes.
- File-backed session restoration across Pi restarts and parent-session branches.
- Interrupt-as-pause semantics with same-context resume and transcript retention after close.
- Spec-driven workflows with placeholders, named outputs, parallel groups, retries, failure policies, and live updates.
- Named workflow `session` keys for sequential conversation reuse.
- Canonical project-trust containment so trust cannot escape the parent project root through absolute paths, traversal, or symlinks.
- Cursor reservations that prevent event sequence reuse across crashes and branch navigation.
- Compaction-safe per-turn output capture.
- Strict TypeScript checks, focused fake-session tests, Pi load checks, and tool-free model-backed lifecycle/workflow smoke tests.
