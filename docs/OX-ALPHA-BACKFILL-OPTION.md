# Ox Alpha as an optional backfill runtime

Ox Alpha is an operator-selected backfill option, not the canonical or default relationship-memory runtime.

## Default boundaries

- Live Subconscious remains `openai-proxy/mimo-v2.5`.
- `SubconsciousBackfill.af` remains unchanged on its canonical DeepSeek backfill model.
- Nothing should automatically switch either agent to Ox Alpha.

## Optional runtime

When an operator deliberately selects Ox Alpha for an isolated or resumed backfill run, use:

- model: `openai-proxy/x-preview-f-free`
- provider: `opencode-zen-free`
- endpoint: `https://opencode.ai/zen/v1`
- provider type: `openai`
- context window: `400000`
- `parallel_tool_calls=true`

Use the existing runtime override path rather than editing `SubconsciousBackfill.af`. In the current runtime this means selecting the model with `LETTA_MODEL=openai-proxy/x-preview-f-free` and keeping the bounded backfill context at `LETTA_CONTEXT_WINDOW=400000`.

## Canary evidence

An isolated five-batch synthetic canary on 2026-08-23 JST completed 5/5 batches with 5 canonical memories and 5 reinforcements. It exercised parallel `memory_search`, `memory_remember`, and `memory_reinforce` calls, including a mixed remember+reinforce batch. Effective Letta context remained 400000, and the live MiMo agent plus the production backfill agent were unchanged.

Ox Alpha occasionally produced a schema-invalid proposal during testing (for example an unsupported payload field). The existing canonical validation gate rejected it and the model corrected the proposal on retry. Therefore Ox Alpha should keep the same fail-closed schema validation, checkpoint, and retry/supervisor protections as other backfill models.

The five-batch run took about 537 seconds in total, so Ox Alpha should be treated as a useful optional model rather than an automatic replacement for the current backfill runtime.
