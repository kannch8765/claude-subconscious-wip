import { describe, expect, it } from 'vitest';
import { disableLettaCodeAutoUpdater } from './letta_code_runtime_env.js';

describe('Letta Code runtime environment', () => {
  it('forces the pinned CLI auto-updater off', () => {
    const env = {
      DISABLE_AUTOUPDATER: '0',
      UNRELATED_VALUE: 'preserved',
    } as NodeJS.ProcessEnv;

    disableLettaCodeAutoUpdater(env);

    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    expect(env.UNRELATED_VALUE).toBe('preserved');
  });
});
