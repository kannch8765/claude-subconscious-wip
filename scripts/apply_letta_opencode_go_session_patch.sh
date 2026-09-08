#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <letta-0.16.8-source-or-site-packages-root>" >&2
  exit 2
fi

TARGET=$(realpath "$1")
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FULL_PATCH="$SCRIPT_DIR/../patches/letta-0.16.8-opencode-go-session.patch"
UPGRADE_PATCH="$SCRIPT_DIR/../patches/letta-0.16.8-opencode-go-session-compaction-upgrade.patch"

required=(
  letta/agents/letta_agent_v2.py
  letta/agents/letta_agent_v3.py
  letta/llm_api/openai_client.py
  letta/services/summarizer/compact.py
  letta/services/summarizer/self_summarizer.py
  letta/services/summarizer/summarizer.py
  letta/services/summarizer/summarizer_all.py
  letta/services/summarizer/summarizer_sliding_window.py
)
for rel in "${required[@]}"; do
  [[ -f "$TARGET/$rel" ]] || { echo "Missing Letta 0.16.8 target file: $TARGET/$rel" >&2; exit 3; }
done
[[ -f "$FULL_PATCH" ]] || { echo "Missing full patch: $FULL_PATCH" >&2; exit 3; }
[[ -f "$UPGRADE_PATCH" ]] || { echo "Missing compaction upgrade patch: $UPGRADE_PATCH" >&2; exit 3; }

legacy_applied() {
  grep -q 'def with_opencode_go_session_header' "$TARGET/letta/llm_api/openai_client.py" \
    && grep -q 'request_data = with_opencode_go_session_header' "$TARGET/letta/agents/letta_agent_v2.py" \
    && grep -q 'request_data = with_opencode_go_session_header' "$TARGET/letta/agents/letta_agent_v3.py"
}

complete_applied() {
  legacy_applied \
    && grep -q 'opencode_session_id=self.conversation_id or self.agent_state.id' "$TARGET/letta/agents/letta_agent_v3.py" \
    && grep -q 'req_data = with_opencode_go_session_header(req_data, llm_config, opencode_session_id)' "$TARGET/letta/services/summarizer/summarizer.py" \
    && grep -q 'opencode_session_id=opencode_session_id' "$TARGET/letta/services/summarizer/compact.py"
}

if complete_applied; then
  echo "Letta OpenCode Go session patch already applied (agent + compaction paths)"
  exit 0
fi

if legacy_applied; then
  PATCH_FILE="$UPGRADE_PATCH"
  MODE=legacy-to-compaction
else
  PATCH_FILE="$FULL_PATCH"
  MODE=pristine-to-full
fi

echo "Applying Letta OpenCode Go session patch mode=$MODE"
patch --dry-run -p1 -d "$TARGET" < "$PATCH_FILE" >/dev/null
patch -p1 -d "$TARGET" < "$PATCH_FILE"

python3 -m py_compile "${required[@]/#/$TARGET/}"
complete_applied || { echo "Letta OpenCode Go session patch post-apply marker verification failed" >&2; exit 4; }

echo "Applied Letta OpenCode Go session patch (agent + compaction paths)"
