# Task 096A — Subcon visibility contract freeze

Frozen upstream: `a9d89b356585d63c488704c2cc32f2690c45d347`.

## Authoritative Claude injection forms

- `UserPromptSubmit` runs `scripts/sync_letta_memory.ts`. Its authoritative injection is the exact stdout string assembled as `outputs.join("\n\n")`. Depending on mode/state it can contain `<letta_context>`, `<letta_memory_blocks>`, `<letta_memory_update>`, `<letta_message>`, and the existing acknowledgement `<instruction>`.
- `PreToolUse` runs `scripts/pretool_sync.ts`. Its authoritative injection is `hookSpecificOutput.additionalContext`, whose value is the exact `contextWithInstruction` string. The context is wrapped in `<letta_update>` and can contain `<letta_message>` and `<letta_memory_update>`; the existing acknowledgement instruction can follow it.

Task 096A does not parse Claude assistant output and does not run a second Letta query. Each hook mirrors the same in-memory string that it is about to emit through the existing authoritative hook channel.

## Local mirror envelope

Mirroring is opt-in and local-only. The owning Claude-P process must provide both:

- `SUBCON_VISIBILITY_DIR`: local private spool root;
- `SUBCON_VISIBILITY_RUN_ID`: an opaque per-Claude-P-process run identity.

Each event is an atomic private JSON file with schema `subcon_visibility_v1` and fields `run_id`, `session_id`, monotonic `sequence`, `phase` (`user_prompt` or `pre_tool`), exact `payload`, and `created_at`.

The run directory name is a SHA-256 digest of `run_id`, so untrusted hook input is never used as a filesystem path. Writes are serialized by a narrow local lock, files are mode `0600`, directories are mode `0700`, retained events/runs are bounded, and oversized payloads fail mirroring rather than being truncated.

Mirror errors are swallowed by `mirrorSubconVisibility()`. Therefore a spool failure cannot mutate, suppress, or delay the authoritative Claude hook output beyond the small bounded best-effort lock attempt.
