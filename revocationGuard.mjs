/**
 * In-process guard against revoking the same access grant twice.
 *
 * A grant's expiry can be acted on by two independent paths: the Slack
 * scheduled message the bot queued when the access was granted, and the
 * periodic catch-up sweep that exists because that scheduled message may never
 * be delivered. Both are needed, and either may run first.
 *
 * Across restarts the `#Duration Access Revoked#` record in the bot's own Slack
 * history is the durable guard - the sweep reads it and skips the grant. This
 * module covers the short window before that record is visible, and the case
 * where both paths fire within the same process.
 *
 * Removing a user from a Twingate group is itself idempotent; what this
 * prevents is a second revoke record, a second notification to the user, and
 * the duplicated audit lines that follow from them.
 */

// requestId -> unix seconds the claim was taken
const claims = new Map();

/**
 * Take exclusive responsibility for revoking `requestId`.
 * Returns true if the caller may proceed, false if another path already has it.
 *
 * Records written before `requestId` existed cannot be de-duplicated, so they
 * are always allowed through rather than silently skipped.
 */
export function claimRevocation(requestId) {
    if (typeof requestId !== "string" || requestId === "") return true;
    if (claims.has(requestId)) return false;
    claims.set(requestId, Date.now() / 1000);
    return true;
}

/** Give the claim back so a later attempt can retry (used when a revoke fails). */
export function releaseRevocation(requestId) {
    if (typeof requestId === "string") claims.delete(requestId);
}

/** Drop claims older than the sweep's look-back window; they are covered by Slack history from then on. */
export function pruneRevocationClaims(olderThanSeconds) {
    const cutoff = (Date.now() / 1000) - olderThanSeconds;
    for (const [requestId, claimedAt] of claims) {
        if (claimedAt < cutoff) claims.delete(requestId);
    }
}

/** Test helper. */
export function resetRevocationClaims() {
    claims.clear();
}
