from pathlib import Path

p = Path('scripts/task_06_apply.py')
s = p.read_text()

lines = s.splitlines()
payload_indexes = [i for i, line in enumerate(lines) if "'replace payloadKeys'" in line]
if len(payload_indexes) != 1:
    raise RuntimeError(f'payloadKeys apply line drifted: {len(payload_indexes)}')
lines[payload_indexes[0]] = "s=regex_once(s, r\"const payloadKeys.*?\\n\\};\", new_defs, 'replace payloadKeys')"
s = '\n'.join(lines) + ('\n' if s.endswith('\n') else '')

start = s.index("old_validator=r'''", s.index('replace payloadKeys'))
end = s.index("\nnew_validator=r'''", start)
actual = """old_validator=r'''  const rules = payloadKeys[kind];
  const allowed = new Set([...rules.required, ...rules.optional]);
  for (const key of Object.keys(input.payload)) {
    if (!allowed.has(key)) return { ok: false, code: 'unknown_payload_field', reason: `Unknown ${kind} payload field: ${key}` };
  }

  const payload: Record<string, unknown> = {};
  for (const key of rules.required) {
    const isArray = rules.arrays?.includes(key) ?? false;
    if (isArray) {
      const cleaned = cleanStringArray(input.payload[key], rules.nonEmptyArrays?.includes(key) ?? false);
      if (!cleaned) return { ok: false, code: 'invalid_payload_field', reason: `${kind}.${key} must be a valid non-empty unique string array.` };
      payload[key] = cleaned;
    } else {
      const cleaned = cleanString(input.payload[key]);
      if (!cleaned) return { ok: false, code: 'invalid_payload_field', reason: `${kind}.${key} must be a non-empty string.` };
      payload[key] = cleaned;
    }
  }

  for (const key of rules.optional) {
    if (!(key in input.payload)) continue;
    if (input.payload[key] === null) return { ok: false, code: 'invalid_optional_null', reason: `${kind}.${key} must be omitted rather than null.` };
    const isArray = rules.arrays?.includes(key) ?? false;
    if (isArray) {
      const cleaned = cleanStringArray(input.payload[key]);
      if (!cleaned) return { ok: false, code: 'invalid_payload_field', reason: `${kind}.${key} must be a unique non-empty string array.` };
      payload[key] = cleaned;
    } else {
      const cleaned = cleanString(input.payload[key]);
      if (!cleaned) return { ok: false, code: 'invalid_payload_field', reason: `${kind}.${key} must be a non-empty string.` };
      payload[key] = cleaned;
    }
  }
'''
"""
s = s[:start] + actual + s[end + 1:]

lines = s.splitlines()
sync_indexes = [i for i, line in enumerate(lines) if "'sync mutation test'" in line]
if len(sync_indexes) != 1:
    raise RuntimeError(f'sync mutation apply line drifted: {len(sync_indexes)}')
extra = "s=replace_once(s,\"    expect(worker).toContain('openStdioMcpToolsFromEnvironment(log)');\", \"    expect(worker).toContain('(dependencies.openStdioMcp ?? openStdioMcpToolsFromEnvironment)(log)');\",'sync stdio fallback test')"
if extra not in lines:
    lines.insert(sync_indexes[0] + 1, extra)
s = '\n'.join(lines) + ('\n' if s.endswith('\n') else '')

old_snapshot_patch = """        old_tg=block['value']
        if old_tg not in text: raise RuntimeError('live compiled bootstrap lacks tool_guidelines snapshot')
        text=text.replace(old_tg,new_tg,1); block['value']=new_tg
"""
new_snapshot_patch = """        old_tg=block['value']
        if old_tg not in text: raise RuntimeError('live compiled bootstrap lacks tool_guidelines snapshot')
        old_snapshot=f\"- chars_current={len(old_tg)}\\n- chars_limit=20000\\n</metadata>\\n<value>\\n{old_tg}\"
        new_snapshot=f\"- chars_current={len(new_tg)}\\n- chars_limit=20000\\n</metadata>\\n<value>\\n{new_tg}\"
        if text.count(old_snapshot) != 1: raise RuntimeError(f'live tool_guidelines compiled snapshot drift: {text.count(old_snapshot)}')
        text=text.replace(old_snapshot,new_snapshot,1); block['value']=new_tg
"""
if s.count(old_snapshot_patch) != 1:
    raise RuntimeError(f'AgentFile snapshot apply block drifted: {s.count(old_snapshot_patch)}')
s = s.replace(old_snapshot_patch, new_snapshot_patch, 1)

anchor = "p='scripts/relationship_memory_backfill_runner.test.ts'; s=read(p)\n"
if s.count(anchor) != 1:
    raise RuntimeError(f'backfill test apply anchor drifted: {s.count(anchor)}')
extra_regressions = """p='scripts/stdio_mcp_client.test.ts'; s=read(p)
s=replace_once(s,\"    expect(worker).toContain('openStdioMcpToolsFromEnvironment(log)');\", \"    expect(worker).toContain('(dependencies.openStdioMcp ?? openStdioMcpToolsFromEnvironment)(log)');\",'stdio mcp fallback test')
write(p,s)

p='relationship-memory/tests/assistant-originated-intent.test.ts'; s=read(p)
s=replace_once(s,'  memoryRememberToolSchema,','  memoryRememberKindToolSchema,','assistant intent schema import')
s=replace_once(s,\"  it('does not expose feel as a memory_remember authority field and projects the exact stored feel', () => {\", \"  it('does not expose feel as a kind-specific memory-create authority field and projects the exact stored feel', () => {\",'assistant intent test title')
s=replace_once(s,'    const schema = memoryRememberToolSchema() as any;',\"    const schema = memoryRememberKindToolSchema('personal_experience') as any;\",'assistant intent schema call')
write(p,s)

"""
s = s.replace(anchor, extra_regressions + anchor, 1)

ts_old = "        if (field.requireNonEmptyArray) expect(property.minItems).toBe(1);"
ts_new = "        if ('requireNonEmptyArray' in field && field.requireNonEmptyArray) expect(property.minItems).toBe(1);"
if s.count(ts_old) != 1:
    raise RuntimeError(f'type-narrowing test line drifted: {s.count(ts_old)}')
s = s.replace(ts_old, ts_new, 1)

p.write_text(s)
print('task-06 prepatch: aligned schema, snapshots, and full-suite regressions')
