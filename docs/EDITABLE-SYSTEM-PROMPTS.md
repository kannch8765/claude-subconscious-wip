# Editing managed system prompts

The two repository-managed system prompts are plain UTF-8 Markdown:

- `config/live-system.md` — managed live Subconscious, including the shared base system used by the experimental sync sibling.
- `config/backfill-system.md` — managed relationship-memory backfill.

Edit the relevant file, then run the normal managed agent resolution/reconciliation path. The prompt is read again on the next managed resolution; it is not permanently cached. Existing managed agents are reconciled from the Markdown source, and newly imported managed agents receive that same prompt in the import payload before creation.

To verify a change, use the repository's prompt/reconciliation tests in an isolated environment and confirm the matching managed role sees the new text while the other role and runtime settings remain unchanged. To roll back, restore the previous Markdown contents and resolve the managed agent again.

Release or installation artifacts must include both files under `config/`. The bundled `Subconscious.af` and `SubconsciousBackfill.af` still contain compatibility snapshots for AgentFile blocks, tools, runtime/bootstrap data, and a serialized `system`. Inside this application those serialized system values are not authoritative. If an external tool imports a raw `.af` directly, bypassing this application's managed import path, it will use the snapshot embedded in the `.af` rather than the Markdown file. Explicit caller-supplied custom AgentFiles likewise keep their own `system` unless the caller explicitly supplies a managed prompt file.
