import { runDeterministicSyncRecall, type SyncRecallRunResult } from './sync_recall.js';

export interface SyncRecallHookInput {
  hook_event_name?: string;
  prompt?: string;
}

export interface SyncRecallAdmissionDecision {
  admitted: boolean;
  reason: 'not_selected' | 'policy_unconfigured' | 'canary_bypass';
}

export type SyncRecallRunner = (query: string) => Promise<SyncRecallRunResult>;

export function decideSyncRecallAdmission(result: SyncRecallRunResult): SyncRecallAdmissionDecision {
  if (result.status !== 'ok' || !result.selected?.envelope) {
    return { admitted: false, reason: 'not_selected' };
  }
  if (process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_CANARY_BYPASS === '1') {
    return { admitted: true, reason: 'canary_bypass' };
  }
  return { admitted: false, reason: 'policy_unconfigured' };
}

export async function resolveSyncRecallInjection(
  hookInput: SyncRecallHookInput | null,
  runner: SyncRecallRunner = runDeterministicSyncRecall,
): Promise<{ output: string; result?: SyncRecallRunResult; admission?: SyncRecallAdmissionDecision }> {
  const isUserPrompt = hookInput?.hook_event_name === 'UserPromptSubmit' || typeof hookInput?.prompt === 'string';
  const prompt = hookInput?.prompt?.trim();
  if (!isUserPrompt || !prompt) return { output: '' };

  try {
    const result = await runner(prompt);
    const admission = decideSyncRecallAdmission(result);
    return {
      output: admission.admitted ? result.selected?.envelope ?? '' : '',
      result,
      admission,
    };
  } catch {
    // Foreground recall is enrichment only. Any runner/provider/runtime failure
    // must fail open: no enrichment stdout, while the user prompt continues.
    return { output: '' };
  }
}

export function composeWhisperModeInjection(syncRecallOutput: string, pendingAsyncOutput: string): string {
  return [syncRecallOutput, pendingAsyncOutput].filter(Boolean).join('\n\n');
}
