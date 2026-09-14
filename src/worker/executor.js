// Queue executor (CONTRACTS.md §Q). Claims queue_items, calls the Books client, and
// classifies the outcome. UNKNOWN_OUTCOME is never auto-retried here — only
// resolveUnknownOutcomes(), via a deterministic searchByMigrationTag lookup, may move
// it forward. AUTH circuit-breaks the whole batch rather than burning through items.
import { assertPostingAllowed } from '../books/guard.js';
import { raise } from '../core/exceptions.js';
import { nowIso } from '../core/ids.js';
import { assertTransition, QUEUE_TRANSITIONS, BATCH_TRANSITIONS, BATCH_STATES } from '../core/states.js';

const DEFAULT_CLAIM_TTL_MS = Number(process.env.WORKER_CLAIM_TTL_MS) || 600_000;
const RETRYABLE_CLASSES = new Set(['RETRYABLE', 'RATE_LIMIT']);

function now(ctx) {
  return ctx.now ? ctx.now() : nowIso();
}

/** CONTRACTS.md §Z: "assertPostingAllowed() (mock passes; live requires guard)". The
 * mock driver has its own internal write guard (config.mockWritesEnabled); this choke
 * point only ever needs to fire for the live driver, but it fires unconditionally
 * before every live create() as defence in depth even though live.js#create() also
 * asserts it internally. */
function assertClientPostingAllowed(client) {
  if (client.driver !== 'live') return;
  assertPostingAllowed(client.config);
}

/** Local full-jitter exponential backoff (limiter.js#fullJitterBackoff is not exported
 * — see CONTRACTS.md task note "reuse limiter helper if exported, else local"). */
function backoffMs(attempt, { baseMs = 500, maxMs = 30_000, random = Math.random } = {}) {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.floor(random() * cap));
}

async function auditItem(ctx, action, { entityId, before, after, reason, branchCode, batchId }) {
  await ctx.audit.emit({
    actor: ctx.actor ?? 'worker',
    actorRole: ctx.actorRole,
    action,
    entityType: 'queue_items',
    entityId,
    before,
    after,
    reason,
    correlationId: ctx.correlationId,
    branchCode,
    batchId,
  });
}

/** Gather claimable candidates: never-claimed QUEUED items, FAILED_RETRYABLE items
 * whose backoff has elapsed (flipped back to QUEUED first, a plain business
 * transition — not a claim), and CLAIMED items whose claim expired (a crashed
 * worker's in-flight item, reclaimable by anyone). */
async function collectCandidates(ctx, batchId) {
  const { store } = ctx;
  const nowTs = now(ctx);

  const queued = await store.find('queue_items', { batch_id: batchId, status: 'QUEUED' });

  const retryable = await store.find('queue_items', { batch_id: batchId, status: 'FAILED_RETRYABLE' });
  const due = retryable.filter((i) => !i.run_after || i.run_after <= nowTs);
  for (const item of due) {
    assertTransition(QUEUE_TRANSITIONS, 'queue_item', 'FAILED_RETRYABLE', 'QUEUED');
    await store.update('queue_items', item.id, { status: 'QUEUED', updated_at: nowTs });
    await auditItem(ctx, 'QUEUE.BACKOFF_ELAPSED', { entityId: item.id, before: { status: 'FAILED_RETRYABLE' }, after: { status: 'QUEUED' }, batchId });
  }

  const claimed = await store.find('queue_items', { batch_id: batchId, status: 'CLAIMED' });
  const expired = claimed.filter((i) => i.claim_expires_at && i.claim_expires_at < nowTs);

  const toClaimAsQueued = [...queued, ...due].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const toReclaim = expired.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

  return { toClaimAsQueued, toReclaim };
}

async function loadPayload(ctx, voucher) {
  const { store } = ctx;
  const payloadRow = await store.findOne('preview_payloads', {
    voucher_id: voucher.id,
    transformation_version: voucher.transformation_version,
    mapping_version: voucher.mapping_version,
  });
  if (!payloadRow) {
    const err = new Error(`No preview_payloads row for voucher ${voucher.id}`);
    err.code = 'PAYLOAD_NOT_FOUND';
    throw err;
  }
  return { module: payloadRow.target_module, payload: JSON.parse(payloadRow.payload_json), payloadRow };
}

/** Process exactly one claimed queue_item end-to-end: insert the api_attempts row
 * BEFORE calling client.create(), classify the outcome, and apply the corresponding
 * queue_items/vouchers state change + exception. Returns a small outcome summary used
 * by runQueueSlice to decide whether to circuit-break. */
async function processItem(ctx, { client, item, batchId, batchRow }) {
  const { store } = ctx;
  const nowTs = now(ctx);
  const voucher = await store.get('vouchers', item.voucher_id);

  let module;
  let payload;
  let payloadRow;
  try {
    ({ module, payload, payloadRow } = await loadPayload(ctx, voucher));
  } catch (err) {
    // Data-integrity gap (payload missing for a MIGRATE voucher that reached the
    // queue): never silently drop the item — dead-letter it for manual review.
    await store.releaseClaim('queue_items', item.id, { workerId: item.claimed_by, newStatus: 'DEAD_LETTER' });
    await store.update('queue_items', item.id, { last_error_code: 'PAYLOAD_NOT_FOUND', updated_at: nowTs });
    await raise(ctx, {
      category: 'SCHEMA_FAILURE', severity: 'P1', message: err.message,
      dedupeKey: `exec:${item.id}:PAYLOAD_NOT_FOUND`, branchCode: voucher?.branch_code, batchId, voucherId: voucher?.id,
    });
    return { circuitBreak: false };
  }

  await store.update('vouchers', voucher.id, { migration_status: 'IN_FLIGHT', updated_at: nowTs });

  const attemptNo = (item.attempts ?? 0) + 1;
  const attemptRow = await store.insert('api_attempts', {
    queue_item_id: item.id,
    attempt_no: attemptNo,
    target_module: module,
    request_hash: payloadRow.payload_hash,
    response_class: 'UNKNOWN',
    http_status: null,
    zoho_record_id: null,
    error_code: null,
    error_message: null,
    retry_after_ms: null,
    started_at: nowTs,
    finished_at: null,
    uk: `${item.id}|${attemptNo}`,
    created_at: nowTs,
  });

  assertClientPostingAllowed(client);

  let classification;
  let value;
  let thrown;
  try {
    value = await client.create(module, payload, { idempotencyKey: item.idempotency_key });
    classification = { class: 'SUCCESS' };
  } catch (err) {
    thrown = err;
    classification = err.classification ?? { class: 'UNKNOWN', reason: err.message };
  }

  const finishedAt = now(ctx);
  await store.update('api_attempts', attemptRow.id, {
    response_class: classification.class,
    http_status: thrown?.httpStatus ?? null,
    zoho_record_id: classification.class === 'SUCCESS' ? (value?.id ?? null) : null,
    error_code: classification.reason ?? null,
    error_message: thrown?.message ?? null,
    retry_after_ms: classification.retry_after_ms ?? null,
    finished_at: finishedAt,
  });

  const attempts = attemptNo;

  if (classification.class === 'SUCCESS') {
    await store.releaseClaim('queue_items', item.id, { workerId: item.claimed_by, newStatus: 'POSTED' });
    await store.update('queue_items', item.id, { attempts, updated_at: finishedAt });
    await store.update('vouchers', voucher.id, {
      migration_status: 'POSTED', zoho_record_id: value?.id ?? null,
      attempt_count: attempts, updated_at: finishedAt,
    });
    await auditItem(ctx, 'QUEUE.POSTED', { entityId: item.id, after: { zohoRecordId: value?.id }, branchCode: voucher.branch_code, batchId });
    return { circuitBreak: false, posted: true };
  }

  if (classification.class === 'AUTH') {
    // Circuit-break: this is a systemic credential problem, not specific to this item.
    // Put the item back to QUEUED untouched and pause the whole batch.
    await store.releaseClaim('queue_items', item.id, { workerId: item.claimed_by, newStatus: 'QUEUED' });
    await store.update('vouchers', voucher.id, { migration_status: 'QUEUED', updated_at: finishedAt });
    if (BATCH_TRANSITIONS[batchRow.status]?.includes(BATCH_STATES.PAUSED)) {
      assertTransition(BATCH_TRANSITIONS, 'batch', batchRow.status, BATCH_STATES.PAUSED);
      await store.update('migration_batches', batchId, { status: BATCH_STATES.PAUSED, updated_at: finishedAt });
    }
    await raise(ctx, {
      category: 'AUTHENTICATION_ERROR', severity: 'P1',
      message: `Authentication failure posting queue item ${item.id}: ${classification.reason ?? thrown?.message}`,
      dedupeKey: `exec:${batchId}:AUTHENTICATION_ERROR`, branchCode: voucher.branch_code, batchId, voucherId: voucher.id,
    });
    await auditItem(ctx, 'QUEUE.AUTH_CIRCUIT_BREAK', { entityId: item.id, branchCode: voucher.branch_code, batchId });
    return { circuitBreak: true };
  }

  if (classification.class === 'NON_RETRYABLE') {
    await store.releaseClaim('queue_items', item.id, { workerId: item.claimed_by, newStatus: 'FAILED_FINAL' });
    await store.update('queue_items', item.id, { attempts, last_error_code: classification.reason ?? 'NON_RETRYABLE', updated_at: finishedAt });
    await store.update('vouchers', voucher.id, {
      migration_status: 'FAILED', attempt_count: attempts,
      last_error_code: classification.reason ?? 'NON_RETRYABLE', last_error_message: thrown?.message ?? null, updated_at: finishedAt,
    });
    await raise(ctx, {
      category: 'API_VALIDATION_ERROR', severity: 'P1',
      message: `Non-retryable API error for queue item ${item.id}: ${thrown?.message ?? classification.reason}`,
      dedupeKey: `exec:${item.id}:API_VALIDATION_ERROR`, branchCode: voucher.branch_code, batchId, voucherId: voucher.id,
    });
    await auditItem(ctx, 'QUEUE.FAILED_FINAL', { entityId: item.id, branchCode: voucher.branch_code, batchId });
    return { circuitBreak: false };
  }

  if (classification.class === 'UNKNOWN') {
    await store.releaseClaim('queue_items', item.id, { workerId: item.claimed_by, newStatus: 'UNKNOWN_OUTCOME' });
    await store.update('queue_items', item.id, { attempts, last_error_code: classification.reason ?? 'UNKNOWN', updated_at: finishedAt });
    await store.update('vouchers', voucher.id, {
      migration_status: 'UNKNOWN_OUTCOME', attempt_count: attempts, updated_at: finishedAt,
    });
    await raise(ctx, {
      category: 'UNKNOWN_API_OUTCOME', severity: 'P1',
      message: `Unknown outcome for queue item ${item.id} (never auto-retried): ${classification.reason ?? thrown?.message}`,
      dedupeKey: `exec:${item.id}:UNKNOWN_API_OUTCOME`, branchCode: voucher.branch_code, batchId, voucherId: voucher.id,
    });
    await auditItem(ctx, 'QUEUE.UNKNOWN_OUTCOME', { entityId: item.id, branchCode: voucher.branch_code, batchId });
    return { circuitBreak: false };
  }

  // RETRYABLE or RATE_LIMIT.
  const maxAttempts = client.config?.maxAttempts ?? (Number(process.env.BOOKS_MAX_ATTEMPTS) || 5);
  if (attempts >= maxAttempts) {
    await store.releaseClaim('queue_items', item.id, { workerId: item.claimed_by, newStatus: 'DEAD_LETTER' });
    await store.update('queue_items', item.id, { attempts, last_error_code: classification.reason ?? classification.class, updated_at: finishedAt });
    await store.update('vouchers', voucher.id, {
      migration_status: 'DEAD_LETTER', attempt_count: attempts,
      last_error_code: classification.reason ?? classification.class, last_error_message: thrown?.message ?? null, updated_at: finishedAt,
    });
    await raise(ctx, {
      category: classification.class === 'RATE_LIMIT' ? 'RATE_LIMIT' : 'TRANSIENT_FAILURE', severity: 'P1',
      message: `Queue item ${item.id} dead-lettered after ${attempts} attempts: ${classification.reason ?? thrown?.message}`,
      dedupeKey: `exec:${item.id}:DEAD_LETTER`, branchCode: voucher.branch_code, batchId, voucherId: voucher.id,
    });
    await auditItem(ctx, 'QUEUE.DEAD_LETTER', { entityId: item.id, branchCode: voucher.branch_code, batchId });
    return { circuitBreak: false };
  }

  const delayMs = classification.retry_after_ms ?? backoffMs(attempts);
  const runAfter = new Date(Date.parse(finishedAt) + delayMs).toISOString();
  await store.releaseClaim('queue_items', item.id, { workerId: item.claimed_by, newStatus: 'FAILED_RETRYABLE' });
  await store.update('queue_items', item.id, {
    attempts, run_after: runAfter, last_error_code: classification.reason ?? classification.class, updated_at: finishedAt,
  });
  await store.update('vouchers', voucher.id, { migration_status: 'QUEUED', attempt_count: attempts, updated_at: finishedAt });
  await auditItem(ctx, 'QUEUE.FAILED_RETRYABLE', { entityId: item.id, after: { runAfter, attempts }, branchCode: voucher.branch_code, batchId });
  return { circuitBreak: false };
}

async function deriveBatchStatus(ctx, batchId) {
  const { store } = ctx;
  const current = await store.get('migration_batches', batchId);
  if (!current || current.status === BATCH_STATES.PAUSED) return current;

  const items = await store.find('queue_items', { batch_id: batchId });
  if (items.length === 0) return current;

  const allPosted = items.every((i) => i.status === 'POSTED');
  const anyPosted = items.some((i) => i.status === 'POSTED');

  let target = null;
  if (allPosted) target = BATCH_STATES.MIGRATED;
  else if (anyPosted) target = BATCH_STATES.PARTIALLY_MIGRATED;

  if (target && target !== current.status && BATCH_TRANSITIONS[current.status]?.includes(target)) {
    assertTransition(BATCH_TRANSITIONS, 'batch', current.status, target);
    return store.update('migration_batches', batchId, { status: target, updated_at: now(ctx) });
  }
  return current;
}

/** Drains up to maxItems queue_items for a batch within timeBudgetMs, claiming each
 * atomically so two concurrent workers never both call client.create() for the same
 * item. Stops immediately (without processing further items) on an AUTH circuit break. */
export async function runQueueSlice(ctx, { client, batchId, workerId, maxItems = 50, timeBudgetMs = 30_000 }) {
  const { store } = ctx;
  const claimTtlMs = ctx.queueClaimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const deadline = Date.now() + timeBudgetMs;

  let batchRow = await store.get('migration_batches', batchId);
  if (!batchRow) throw Object.assign(new Error(`migration_batch not found: ${batchId}`), { code: 'BATCH_NOT_FOUND' });
  if (batchRow.status === BATCH_STATES.PAUSED) {
    return { processed: 0, posted: 0, circuitBroken: false, batch: batchRow };
  }
  if (batchRow.status === BATCH_STATES.QUEUED) {
    assertTransition(BATCH_TRANSITIONS, 'batch', batchRow.status, BATCH_STATES.MIGRATING);
    batchRow = await store.update('migration_batches', batchId, { status: BATCH_STATES.MIGRATING, updated_at: now(ctx) });
  }

  const { toClaimAsQueued, toReclaim } = await collectCandidates(ctx, batchId);
  const candidates = [
    ...toClaimAsQueued.map((item) => ({ item, expectedStatus: 'QUEUED' })),
    ...toReclaim.map((item) => ({ item, expectedStatus: 'CLAIMED' })),
  ];

  let processed = 0;
  let posted = 0;
  let circuitBroken = false;

  for (const candidate of candidates) {
    if (processed >= maxItems) break;
    if (Date.now() >= deadline) break;

    const claimed = await store.claim('queue_items', candidate.item.id, {
      workerId, expectedStatus: candidate.expectedStatus, newStatus: 'CLAIMED', ttlMs: claimTtlMs,
    });
    if (!claimed) continue; // another worker won the race

    const result = await processItem(ctx, { client, item: claimed, batchId, batchRow });
    processed += 1;
    if (result.posted) posted += 1;
    if (result.circuitBreak) {
      circuitBroken = true;
      break;
    }
  }

  batchRow = await deriveBatchStatus(ctx, batchId);
  return { processed, posted, circuitBroken, batch: batchRow };
}

/** UNKNOWN_OUTCOME items are never auto-retried by runQueueSlice. This does the
 * deterministic lookup instead: exactly one match -> POSTED; none -> back to QUEUED;
 * more than one -> TARGET_MISMATCH + DEAD_LETTER (a duplicate financial record is a
 * P1, not something to guess about). */
export async function resolveUnknownOutcomes(ctx, { client, batchId }) {
  const { store } = ctx;
  const items = await store.find('queue_items', { batch_id: batchId, status: 'UNKNOWN_OUTCOME' });

  let resolvedPosted = 0;
  let resolvedRequeued = 0;
  let resolvedDeadLettered = 0;

  for (const item of items) {
    const voucher = await store.get('vouchers', item.voucher_id);
    const nowTs = now(ctx);
    const matches = await client.searchByMigrationTag({ module: voucher.target_module, sourceHash: item.idempotency_key });

    if (matches.length === 1) {
      assertTransition(QUEUE_TRANSITIONS, 'queue_item', 'UNKNOWN_OUTCOME', 'POSTED');
      await store.update('queue_items', item.id, { status: 'POSTED', updated_at: nowTs });
      await store.update('vouchers', voucher.id, { migration_status: 'POSTED', zoho_record_id: matches[0].id, updated_at: nowTs });
      await auditItem(ctx, 'QUEUE.UNKNOWN_RESOLVED_POSTED', { entityId: item.id, after: { zohoRecordId: matches[0].id }, branchCode: voucher.branch_code, batchId });
      resolvedPosted += 1;
      continue;
    }

    if (matches.length === 0) {
      assertTransition(QUEUE_TRANSITIONS, 'queue_item', 'UNKNOWN_OUTCOME', 'QUEUED');
      await store.update('queue_items', item.id, { status: 'QUEUED', run_after: null, updated_at: nowTs });
      await store.update('vouchers', voucher.id, { migration_status: 'QUEUED', updated_at: nowTs });
      await auditItem(ctx, 'QUEUE.UNKNOWN_RESOLVED_REQUEUED', { entityId: item.id, branchCode: voucher.branch_code, batchId });
      resolvedRequeued += 1;
      continue;
    }

    // > 1 match: ambiguous target — never guess which one is "ours".
    assertTransition(QUEUE_TRANSITIONS, 'queue_item', 'UNKNOWN_OUTCOME', 'DEAD_LETTER');
    await store.update('queue_items', item.id, { status: 'DEAD_LETTER', last_error_code: 'TARGET_MISMATCH', updated_at: nowTs });
    await store.update('vouchers', voucher.id, { migration_status: 'DEAD_LETTER', updated_at: nowTs });
    await raise(ctx, {
      category: 'TARGET_MISMATCH', severity: 'P1',
      message: `${matches.length} Books records match migration tag for queue item ${item.id}; ambiguous`,
      dedupeKey: `exec:${item.id}:TARGET_MISMATCH`, branchCode: voucher.branch_code, batchId, voucherId: voucher.id,
      evidence: { matches: matches.map((m) => m.id) },
    });
    await auditItem(ctx, 'QUEUE.UNKNOWN_RESOLVED_TARGET_MISMATCH', { entityId: item.id, branchCode: voucher.branch_code, batchId });
    resolvedDeadLettered += 1;
  }

  const batch = await deriveBatchStatus(ctx, batchId);
  return { resolvedPosted, resolvedRequeued, resolvedDeadLettered, batch };
}
