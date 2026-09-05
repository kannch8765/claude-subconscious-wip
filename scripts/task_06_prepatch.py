from pathlib import Path

p = Path('scripts/task_06_apply.py')
s = p.read_text()

old_line = "s=regex_once(s, r\"const payloadKeys = \\{.*?\\} satisfies Record<MemoryKind, \\{ required: string\\[\\]; optional: string\\[\\]; arrays: string\\[\\]; nonEmptyArrays\\?: string\\[\\] \\}>;\", new_defs, 'replace payloadKeys')"
new_line = "s=regex_once(s, r\"const payloadKeys: Record<MemoryKind, \\{ required: string\\[\\]; optional: string\\[\\]; arrays\\?: string\\[\\]; nonEmptyArrays\\?: string\\[\\] \\}> = \\{.*?\\n\\};\", new_defs, 'replace payloadKeys')"
if s.count(old_line) != 1:
    raise RuntimeError(f'payloadKeys apply pattern drifted: {s.count(old_line)}')
s = s.replace(old_line, new_line, 1)

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
p.write_text(s)
print('task-06 prepatch: aligned apply script to exact branch schema syntax')
