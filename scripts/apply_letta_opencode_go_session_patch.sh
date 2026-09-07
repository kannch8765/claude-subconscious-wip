#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /path/to/site-packages" >&2
  exit 2
fi

site_packages=$1
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
patch_file="$repo_root/patches/letta-0.16.8-opencode-go-session.patch"

required=(
  letta/agents/letta_agent_v2.py
  letta/agents/letta_agent_v3.py
  letta/llm_api/openai_client.py
)
for relative in "${required[@]}"; do
  [[ -f "$site_packages/$relative" ]] || { echo "missing Letta 0.16.8 target: $site_packages/$relative" >&2; exit 2; }
done

if grep -q 'def with_opencode_go_session_header' "$site_packages/letta/llm_api/openai_client.py" \
  && grep -q 'with_opencode_go_session_header(' "$site_packages/letta/agents/letta_agent_v2.py" \
  && grep -q 'with_opencode_go_session_header(' "$site_packages/letta/agents/letta_agent_v3.py"; then
  echo "Letta OpenCode Go session patch already applied"
  exit 0
fi

(
  cd "$site_packages"
  patch --dry-run -p1 < "$patch_file"
  patch -p1 < "$patch_file"
)

echo "Applied Letta OpenCode Go session patch"
