export function disableLettaCodeAutoUpdater(env: NodeJS.ProcessEnv = process.env): void {
  // Subconscious pins the SDK/CLI pair in package-lock.json. Letta Code's own
  // updater must not mutate that reviewed runtime while an observer/recall run is active.
  env.DISABLE_AUTOUPDATER = '1';
}
