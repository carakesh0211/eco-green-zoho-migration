// Append-only audit trail. See CONTRACTS.md §A. Never updates or deletes.
import { redact } from './log.js';
import { nowIso } from './ids.js';

export class MissingCorrelationIdError extends Error {
  constructor() {
    super('audit.emit() requires a correlationId');
    this.code = 'MISSING_CORRELATION_ID';
  }
}

/** Factory: createAudit(store) -> { emit }. */
export function createAudit(store) {
  return {
    /**
     * audit.emit({ actor, actorRole, action, entityType, entityId, before, after,
     *              reason, authorizationDecision = 'ALLOWED', correlationId,
     *              branchCode, period, batchId })
     * Inserts one row into audit_events. before/after are JSON-serialised through
     * redact() so secrets never land in the audit trail. Never updates or deletes.
     */
    async emit({
      actor,
      actorRole = null,
      action,
      entityType,
      entityId = null,
      before = null,
      after = null,
      reason = null,
      authorizationDecision = 'ALLOWED',
      correlationId,
      branchCode = null,
      period = null,
      batchId = null,
    }) {
      if (!correlationId) throw new MissingCorrelationIdError();
      if (!actor) throw new TypeError('audit.emit() requires an actor');
      if (!action) throw new TypeError('audit.emit() requires an action');
      if (!entityType) throw new TypeError('audit.emit() requires an entityType');

      const row = {
        actor,
        actor_role: actorRole,
        action,
        entity_type: entityType,
        entity_id: entityId === null || entityId === undefined ? null : String(entityId),
        before_json: before === null || before === undefined ? null : JSON.stringify(redact(before)),
        after_json: after === null || after === undefined ? null : JSON.stringify(redact(after)),
        reason,
        authorization_decision: authorizationDecision,
        correlation_id: correlationId,
        branch_code: branchCode,
        period,
        batch_id: batchId,
        created_at: nowIso(),
      };
      return store.insert('audit_events', row);
    },
  };
}
