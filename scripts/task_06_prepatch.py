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

p.write_text(s)
print('task-06 prepatch: aligned exact schema block and sync fallback assertion')
