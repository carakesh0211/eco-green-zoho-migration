// Which extraction run is "current" for a branch.
//
// Re-uploading files whose bytes are already registered (same sha256) fails ingest with
// DUPLICATE_FILE for every file and leaves an extraction_runs row in VALIDATION_FAILED that
// holds no source_files and no vouchers (src/core/ingest.js#processFile). The data it
// carried already lives in an earlier run, so that row must not hide the earlier run from
// the branch summary or the branch workspace.

/** Error code stored on a run whose only validation failures were DUPLICATE_FILE. */
export const DUPLICATE_ONLY_ERROR = 'DUPLICATE_FILE';

/**
 * True when a VALIDATION_FAILED run failed only because every file duplicated one already
 * held. Runs failed before ingest recorded `error_code` are recognised by having no
 * source_files rows (a file that failed for any other reason still gets one) and at least
 * one DUPLICATE_FILE exception.
 */
export async function isDuplicateOnlyRun(store, run) {
  if (!run || run.status !== 'VALIDATION_FAILED') return false;
  if (run.error_code === DUPLICATE_ONLY_ERROR) return true;
  const files = await store.find('source_files', { run_id: run.id });
  if (files.length > 0) return false;
  const dups = await store.find('exceptions', { run_id: run.id, category: 'DUPLICATE_FILE' });
  return dups.length > 0;
}

/** The newest run that is not a duplicate-only upload; falls back to the newest run. */
export async function currentRun(store, runsNewestFirst) {
  for (const run of runsNewestFirst) {
    if (!(await isDuplicateOnlyRun(store, run))) return run;
  }
  return runsNewestFirst[0] ?? null;
}
