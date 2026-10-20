import {SlackProfileManager} from "./SlackProfileManager.mjs";
import {SelfServeApproval} from "./profileFlows/SelfServeApproval.mjs";
import {claimRevocation, releaseRevocation, pruneRevocationClaims} from "./revocationGuard.mjs";

const DAY = 60 * 60 * 24;

// Never look back less than this, so behaviour is unchanged for profiles that
// only grant short durations.
const MIN_LOOKBACK_SECONDS = 3 * DAY;

// Headroom on top of the longest grantable duration. This is how long a grant
// can sit expired-but-unrevoked and still be caught, so in practice it is the
// outage the sweep can recover from: a grant only goes unswept while the
// service is down. A week covers a weekend plus a bank holiday.
const DEFAULT_LOOKBACK_MARGIN_SECONDS = 7 * DAY;

const DEFAULT_INTERVAL_SECONDS = 300;

// Slack caps `limit` at 1000 and recommends no more than 200 per page.
const HISTORY_PAGE_SIZE = 200;

// Stops a pathological history from pinning the sweep forever. 100 pages of
// 200 is 20,000 messages, far more than this channel will ever hold.
const MAX_HISTORY_PAGES = 100;

function numberFromEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * The longest access any configured profile can actually grant, in seconds.
 * Derived from the profiles rather than hardcoded, so adding `30d` or `90d` to
 * a profile's `timeOptions` later cannot silently leave grants unsweepable.
 */
export function longestGrantableSeconds(profileConfig) {
    let longest = 0;
    for (const profile of (profileConfig && profileConfig.profiles) || []) {
        if (!profile || typeof profile.allowedTimeOptions !== "function" || typeof profile.durationParser !== "function") continue;
        for (const label of profile.allowedTimeOptions()) {
            if (label === "Forever") continue;   // never expires, so never swept
            try {
                longest = Math.max(longest, profile.durationParser(0, label));
            } catch (e) {
                // An unparseable label cannot be granted either, so ignore it.
            }
        }
    }
    return longest;
}

/**
 * Builds the catch-up sweeper.
 *
 * Expiry normally happens when Slack delivers the scheduled message the bot
 * queued at grant time. That delivery is not guaranteed: if the pod is down
 * when it fires, Slack retries a few times and then gives up, and the access is
 * never revoked. This sweep is the backstop, and it runs periodically rather
 * than only at startup so that a missed delivery is corrected within one
 * interval instead of waiting for the next deploy.
 */
export function createExpirySweeper({
    app,
    profileConfig,
    createProfileManager = () => new SlackProfileManager(),
    intervalSeconds = numberFromEnv("EXPIRY_SWEEP_INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS),
    lookbackMarginSeconds = numberFromEnv("EXPIRY_SWEEP_LOOKBACK_MARGIN_DAYS", DEFAULT_LOOKBACK_MARGIN_SECONDS / DAY) * DAY,
    logger = console
} = {}) {
    let botInfo = null;
    let selfChannel = null;
    let timer = null;
    let stopping = false;
    let running = false;

    const lookbackSeconds = () =>
        Math.max(MIN_LOOKBACK_SECONDS, longestGrantableSeconds(profileConfig) + lookbackMarginSeconds);

    // Posts "Service Started!" exactly once, to discover the bot's own DM
    // channel id. Later sweeps reuse it, so running on an interval does not
    // spam that channel.
    async function resolveSelfChannel(client) {
        if (selfChannel) return selfChannel;
        botInfo = await client.auth.test();
        const selfMessage = await client.chat.postMessage({channel: botInfo.user_id, text: "Service Started!"});
        selfChannel = selfMessage.channel;
        return selfChannel;
    }

    async function fetchHistory(client, channel, oldest) {
        const messages = [];
        let cursor;
        let pages = 0;

        do {
            const response = await client.conversations.history({
                channel,
                oldest: String(oldest),
                limit: HISTORY_PAGE_SIZE,
                cursor
            });
            if (Array.isArray(response.messages)) messages.push(...response.messages);
            cursor = (response.response_metadata && response.response_metadata.next_cursor) || undefined;
            pages += 1;
        } while (cursor && pages < MAX_HISTORY_PAGES);

        if (cursor) {
            logger.warn(`Expiry sweep stopped after ${MAX_HISTORY_PAGES} pages of history; some records were not read.`);
        }
        return messages;
    }

    // A message in this channel may legitimately have no `text` (a file share,
    // a tombstone), and a record may be truncated. Neither is a reason to
    // abandon the sweep and leave every other expired grant in place.
    function parseRecords(messages, marker) {
        const records = [];
        for (const message of messages) {
            if (!message || typeof message.text !== "string") continue;
            if (!message.text.startsWith(marker)) continue;
            try {
                records.push(JSON.parse(message.text.slice(marker.length)));
            } catch (e) {
                logger.warn(`Expiry sweep could not parse a '${marker}' record, skipping it: ${e.message}`);
            }
        }
        return records;
    }

    async function runOnce() {
        if (running) return {revoked: 0, failed: 0, scanned: 0, skipped: true};
        running = true;
        try {
            const client = app.client;
            const channel = await resolveSelfChannel(client);
            const lookback = lookbackSeconds();
            const oldest = (Date.now() / 1000) - lookback;

            const messages = await fetchHistory(client, channel, oldest);

            const grants = parseRecords(messages, SelfServeApproval.GRANT_ACCESS_MESSAGE);
            const revokes = parseRecords(messages, SelfServeApproval.REVOKE_ACCESS_MESSAGE);
            const revokedIds = new Set(revokes.map(revoke => revoke.requestId));

            const timeNow = Date.now() / 1000;
            const expired = grants.filter(grant =>
                !revokedIds.has(grant.requestId) &&
                typeof grant.expiry === "number" &&
                grant.expiry < timeNow
            );

            let revoked = 0;
            let failed = 0;

            for (const grant of expired) {
                // Another path (a delivered scheduled trigger, or an earlier
                // sweep whose revoke record is not visible yet) may already own
                // this one.
                if (!claimRevocation(grant.requestId)) continue;

                try {
                    const profileManager = createProfileManager();
                    await profileManager.removeUserFromGroup(grant.requestedGroupId, grant.requesterTwingateId);
                    await client.chat.postMessage({
                        channel: botInfo.user_id,
                        text: `${SelfServeApproval.REVOKE_ACCESS_MESSAGE}${JSON.stringify(grant)}`,
                    });
                    revoked += 1;
                    logger.log(`User ${grant.requesterEmail} profile _'${grant.requestedProfile}'_ access expired but not yet revoked, revoking now. Group: ${grant.requestedGroupName} Duration: ${grant.selectedTime}`);
                } catch (error) {
                    // Give the claim back so the next sweep retries, and keep
                    // going: one unreachable group must not strand the others.
                    releaseRevocation(grant.requestId);
                    failed += 1;
                    logger.error(`Expiry sweep failed to revoke ${grant.requestedGroupName} for ${grant.requesterEmail}: ${error.message}`);
                }
            }

            pruneRevocationClaims(lookback);
            return {revoked, failed, scanned: grants.length, skipped: false};
        } finally {
            running = false;
        }
    }

    function schedule(delayMs) {
        timer = setTimeout(async () => {
            timer = null;
            try {
                await runOnce();
            } catch (error) {
                logger.error(error);
            }
            // Scheduling the next run only after this one finishes makes
            // overlap structurally impossible, however long a sweep takes.
            if (!stopping) schedule(delayMs);
        }, delayMs);
        if (typeof timer.unref === "function") timer.unref();
    }

    function start() {
        if (timer || intervalSeconds <= 0) return;
        stopping = false;
        schedule(intervalSeconds * 1000);
    }

    function stop() {
        stopping = true;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    return {runOnce, start, stop, lookbackSeconds, intervalSeconds};
}
