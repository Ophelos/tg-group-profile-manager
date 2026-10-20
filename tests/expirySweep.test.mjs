import test from "node:test";
import assert from "node:assert/strict";

import {createExpirySweeper} from "../expirySweep.mjs";
import {SelfServeApproval} from "../profileFlows/SelfServeApproval.mjs";

const DAY = 60 * 60 * 24;
const HOUR = 60 * 60;
const JIT_GROUP = "Prod ArgoCD — JIT access";

// --- test doubles -----------------------------------------------------------

function makeFakeApp() {
    const registered = {actions: [], views: [], messages: []};
    return {
        registered,
        action: (id, fn) => registered.actions.push([id, fn]),
        view: (id, fn) => registered.views.push([id, fn]),
        message: (...args) => registered.messages.push(args),
        lookupTgUserFromSlackUserId: async () => null,
        refreshHome: async () => {}
    };
}

/**
 * A Slack client whose DM history is a fixed list of messages. `history`
 * honours `oldest`, `limit` and `cursor` the way Slack does, so a sweep that
 * does not paginate will only ever see the first page.
 */
function makeFakeClient({history = [], pageSize = 100} = {}) {
    const calls = {postMessage: [], history: []};
    const messages = [...history];

    return {
        calls,
        messages,
        auth: {test: async () => ({user_id: "U_bot", bot_id: "B_bot"})},
        chat: {
            postMessage: async (opts) => {
                calls.postMessage.push(opts);
                // Bookkeeping the bot posts to itself becomes part of its own
                // history, exactly as it does in Slack.
                if (typeof opts.text === "string" && opts.text.startsWith("#")) {
                    messages.push({ts: String(Date.now() / 1000), text: opts.text, bot_id: "B_bot"});
                }
                return {ts: String(Date.now() / 1000), channel: "D_self"};
            },
            scheduleMessage: async () => ({scheduled_message_id: "Q1"})
        },
        conversations: {
            history: async ({channel, oldest, limit, cursor}) => {
                calls.history.push({channel, oldest, limit, cursor});
                const eligible = messages
                    .filter(m => oldest === undefined || Number(m.ts) >= Number(oldest))
                    .sort((a, b) => Number(b.ts) - Number(a.ts));
                // Slack caps the page size server-side; asking for more does
                // not avoid the need to paginate.
                const size = Math.min(limit || pageSize, pageSize);
                const start = cursor ? Number(cursor) : 0;
                const page = eligible.slice(start, start + size);
                const next = start + size < eligible.length ? String(start + size) : undefined;
                return {
                    messages: page,
                    has_more: next !== undefined,
                    response_metadata: next ? {next_cursor: next} : {}
                };
            }
        }
    };
}

function makeFakeProfileManager() {
    const calls = {removeUserFromGroup: []};
    return {
        calls,
        removeUserFromGroup: async (groupId, userId) => {
            calls.removeUserFromGroup.push([groupId, userId]);
            return {};
        }
    };
}

function makeProfileConfig(timeOptions = ["1h", "8h", "24h", "7d"]) {
    const app = makeFakeApp();
    const profileConfig = {
        profiles: [{
            profileName: "Ophelos Production JIT",
            profileType: "selfServeApproval",
            groups: [JIT_GROUP],
            timeOptions,
            applicableToGroup: "Everyone",
            approverGroup: "Ophelos Platform Team"
        }],
        groupPermissions: {}
    };
    profileConfig.profiles = [new SelfServeApproval(app, profileConfig, 0)];
    return {app, profileConfig};
}

/** A `#Duration Access Granted#` bookkeeping message as the bot writes it. */
function grantMessage({requestId, postedAgoSeconds, expiryAgoSeconds, selectedTime = "7 Days"}) {
    const now = Date.now() / 1000;
    const request = {
        requestId,
        requestedProfile: "Ophelos Production JIT",
        requestedProfileType: "selfServeApproval",
        requesterTwingateId: "TG_requester",
        requesterEmail: "requester@ophelos.com",
        requesterSlackId: "U_requester",
        requestedGroupName: JIT_GROUP,
        requestedGroupId: `G_${JIT_GROUP}`,
        reasonForRequest: "investigating",
        approverSlackId: "U_approver",
        selectedTime,
        selfApproval: false,
        expiry: Math.round(now - expiryAgoSeconds)
    };
    return {
        ts: String(now - postedAgoSeconds),
        bot_id: "B_bot",
        text: `${SelfServeApproval.GRANT_ACCESS_MESSAGE}${JSON.stringify(request)}`
    };
}

function revokeMessage({requestId, postedAgoSeconds}) {
    return {
        ts: String(Date.now() / 1000 - postedAgoSeconds),
        bot_id: "B_bot",
        text: `${SelfServeApproval.REVOKE_ACCESS_MESSAGE}${JSON.stringify({requestId})}`
    };
}

function sweeperFor(client, {timeOptions, intervalSeconds} = {}) {
    const {app, profileConfig} = makeProfileConfig(timeOptions);
    app.client = client;
    const profileManager = makeFakeProfileManager();
    const sweeper = createExpirySweeper({
        app,
        profileConfig,
        createProfileManager: () => profileManager,
        intervalSeconds
    });
    return {sweeper, profileManager, app, profileConfig};
}

// --- 1. look-back window ----------------------------------------------------

test("REGRESSION: a 7d grant missed while the bot was down longer than the grant itself is still swept", async () => {
    // The grant was recorded 9 days ago for 7 days, so it expired 2 days ago.
    // The bot was down across the expiry. Upstream's fixed 3-day look-back
    // filters on the grant's post time, so this record is invisible and the
    // user keeps production access indefinitely.
    const client = makeFakeClient({
        history: [grantMessage({requestId: "r-7d", postedAgoSeconds: 9 * DAY, expiryAgoSeconds: 2 * DAY})]
    });
    const {sweeper, profileManager} = sweeperFor(client);

    const result = await sweeper.runOnce();

    assert.equal(result.revoked, 1, "the expired 7d grant must be revoked");
    assert.deepEqual(profileManager.calls.removeUserFromGroup, [[`G_${JIT_GROUP}`, "TG_requester"]]);
});

test("the look-back window is derived from the configured timeOptions", async () => {
    const short = sweeperFor(makeFakeClient(), {timeOptions: ["1h", "8h"]});
    const long = sweeperFor(makeFakeClient(), {timeOptions: ["1h", "8h", "24h", "7d"]});
    const longest = sweeperFor(makeFakeClient(), {timeOptions: ["30d", "90d"]});

    // Always at least as long as upstream's 3 days...
    assert.ok(short.sweeper.lookbackSeconds() >= 3 * DAY);
    // ...and always longer than the longest duration the profile can grant, so
    // adding 30d/90d later cannot silently reintroduce the hole.
    assert.ok(long.sweeper.lookbackSeconds() > 7 * DAY,
        `expected > 7d, got ${long.sweeper.lookbackSeconds() / DAY}d`);
    assert.ok(longest.sweeper.lookbackSeconds() > 90 * DAY,
        `expected > 90d, got ${longest.sweeper.lookbackSeconds() / DAY}d`);

    // The margin above the longest duration is the outage the sweep can
    // recover from, so it must be days rather than a token buffer.
    assert.ok(long.sweeper.lookbackSeconds() - 7 * DAY >= 7 * DAY,
        "at least a week of downtime must be recoverable");
    assert.ok(longest.sweeper.lookbackSeconds() - 90 * DAY >= 7 * DAY);
});

test("the look-back margin is configurable", async () => {
    const {app, profileConfig} = makeProfileConfig(["7d"]);
    app.client = makeFakeClient();
    const sweeper = createExpirySweeper({
        app,
        profileConfig,
        createProfileManager: () => makeFakeProfileManager(),
        lookbackMarginSeconds: 30 * DAY
    });
    assert.equal(sweeper.lookbackSeconds(), 37 * DAY);
});

test("a grant that has not expired yet is left alone", async () => {
    const client = makeFakeClient({
        history: [grantMessage({requestId: "r-live", postedAgoSeconds: 1 * DAY, expiryAgoSeconds: -6 * DAY})]
    });
    const {sweeper, profileManager} = sweeperFor(client);

    const result = await sweeper.runOnce();
    assert.equal(result.revoked, 0);
    assert.deepEqual(profileManager.calls.removeUserFromGroup, []);
});

test("a grant that already has a revoke record is left alone", async () => {
    const client = makeFakeClient({
        history: [
            grantMessage({requestId: "r-done", postedAgoSeconds: 9 * DAY, expiryAgoSeconds: 2 * DAY}),
            revokeMessage({requestId: "r-done", postedAgoSeconds: 2 * DAY})
        ]
    });
    const {sweeper, profileManager} = sweeperFor(client);

    assert.equal((await sweeper.runOnce()).revoked, 0);
    assert.deepEqual(profileManager.calls.removeUserFromGroup, []);
});

// --- 2. pagination ----------------------------------------------------------

test("conversations.history is paginated to completion", async () => {
    // One expired grant, buried behind more than a full page of other messages.
    const filler = Array.from({length: 150}, (_, i) => ({
        ts: String(Date.now() / 1000 - i),
        bot_id: "B_bot",
        text: "Service Started!"
    }));
    const buried = grantMessage({requestId: "r-buried", postedAgoSeconds: 6 * DAY, expiryAgoSeconds: 1 * DAY});

    const client = makeFakeClient({history: [...filler, buried], pageSize: 100});
    const {sweeper, profileManager} = sweeperFor(client);

    const result = await sweeper.runOnce();

    assert.ok(client.calls.history.length > 1, "more than one page must be fetched");
    assert.ok(client.calls.history.some(c => c.cursor), "the cursor must be followed");
    assert.equal(result.revoked, 1, "a grant beyond the first page must still be swept");
    assert.deepEqual(profileManager.calls.removeUserFromGroup, [[`G_${JIT_GROUP}`, "TG_requester"]]);
});

// --- 3. messages without a text field ---------------------------------------

test("a message with no text field does not abort the sweep", async () => {
    const client = makeFakeClient({
        history: [
            {ts: String(Date.now() / 1000 - 10), bot_id: "B_bot", files: [{id: "F1"}]},   // no text
            {ts: String(Date.now() / 1000 - 11), bot_id: "B_bot", text: null},            // null text
            grantMessage({requestId: "r-after-junk", postedAgoSeconds: 6 * DAY, expiryAgoSeconds: 1 * DAY})
        ]
    });
    const {sweeper, profileManager} = sweeperFor(client);

    const result = await sweeper.runOnce();

    assert.equal(result.revoked, 1, "the malformed messages must be skipped, not fatal");
    assert.deepEqual(profileManager.calls.removeUserFromGroup, [[`G_${JIT_GROUP}`, "TG_requester"]]);
});

test("an unparseable bookkeeping record does not abort the sweep", async () => {
    const client = makeFakeClient({
        history: [
            {ts: String(Date.now() / 1000 - 10), bot_id: "B_bot", text: `${SelfServeApproval.GRANT_ACCESS_MESSAGE}{not json`},
            grantMessage({requestId: "r-after-bad-json", postedAgoSeconds: 6 * DAY, expiryAgoSeconds: 1 * DAY})
        ]
    });
    const {sweeper, profileManager} = sweeperFor(client);

    assert.equal((await sweeper.runOnce()).revoked, 1);
});

// --- 4. interval sweeping, overlap and double-revoke ------------------------

test("the sweeper runs on an interval and stops cleanly", async () => {
    const client = makeFakeClient({history: []});
    const {sweeper} = sweeperFor(client, {intervalSeconds: 0.01});

    sweeper.start();
    await new Promise(resolve => setTimeout(resolve, 80));
    sweeper.stop();
    const runsWhileRunning = client.calls.history.length;

    assert.ok(runsWhileRunning >= 3, `expected repeated sweeps, saw ${runsWhileRunning}`);

    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(client.calls.history.length, runsWhileRunning, "no sweeps after stop()");
});

test("the interval posts 'Service Started!' only once, not on every sweep", async () => {
    const client = makeFakeClient({history: []});
    const {sweeper} = sweeperFor(client, {intervalSeconds: 0.01});

    sweeper.start();
    await new Promise(resolve => setTimeout(resolve, 80));
    sweeper.stop();

    const startups = client.calls.postMessage.filter(m => m.text === "Service Started!");
    assert.equal(startups.length, 1, `expected 1 startup post, saw ${startups.length}`);
});

test("a slow sweep cannot overlap itself", async () => {
    const client = makeFakeClient({history: []});
    let inFlight = 0;
    let maxInFlight = 0;
    const slowHistory = client.conversations.history;
    client.conversations.history = async (args) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 40));
        const result = await slowHistory(args);
        inFlight -= 1;
        return result;
    };

    const {sweeper} = sweeperFor(client, {intervalSeconds: 0.001});
    sweeper.start();
    await new Promise(resolve => setTimeout(resolve, 150));
    sweeper.stop();

    assert.equal(maxInFlight, 1, "sweeps must not overlap");
});

test("a sweep and a delivered scheduled trigger cannot double-revoke", async () => {
    const grant = grantMessage({requestId: "r-race", postedAgoSeconds: 6 * DAY, expiryAgoSeconds: 1 * DAY});
    const request = JSON.parse(grant.text.replace(SelfServeApproval.GRANT_ACCESS_MESSAGE, ""));

    const client = makeFakeClient({history: [grant]});
    const {sweeper, profileManager, profileConfig} = sweeperFor(client);
    const profile = profileConfig.profiles[0];
    profile.createProfileManager = () => profileManager;

    // The sweep revokes it, then Slack finally delivers the scheduled trigger
    // for the same request.
    await sweeper.runOnce();
    await profile.scheduledMessageTrigger({
        event: {text: `${SelfServeApproval.MESSAGE_TRIGGER}${JSON.stringify(request)}`, bot_id: "B_bot"},
        client,
        logger: {error: () => {}}
    });

    assert.equal(profileManager.calls.removeUserFromGroup.length, 1,
        "the group membership must be removed exactly once");
    const revokes = client.calls.postMessage.filter(
        m => typeof m.text === "string" && m.text.startsWith(SelfServeApproval.REVOKE_ACCESS_MESSAGE));
    assert.equal(revokes.length, 1, "exactly one revoke record must be written");
});

test("a delivered scheduled trigger followed by a sweep cannot double-revoke", async () => {
    const grant = grantMessage({requestId: "r-race-2", postedAgoSeconds: 6 * DAY, expiryAgoSeconds: 1 * DAY});
    const request = JSON.parse(grant.text.replace(SelfServeApproval.GRANT_ACCESS_MESSAGE, ""));

    const client = makeFakeClient({history: [grant]});
    const {sweeper, profileManager, profileConfig} = sweeperFor(client);
    const profile = profileConfig.profiles[0];
    profile.createProfileManager = () => profileManager;

    await profile.scheduledMessageTrigger({
        event: {text: `${SelfServeApproval.MESSAGE_TRIGGER}${JSON.stringify(request)}`, bot_id: "B_bot"},
        client,
        logger: {error: () => {}}
    });
    await sweeper.runOnce();

    assert.equal(profileManager.calls.removeUserFromGroup.length, 1);
    const revokes = client.calls.postMessage.filter(
        m => typeof m.text === "string" && m.text.startsWith(SelfServeApproval.REVOKE_ACCESS_MESSAGE));
    assert.equal(revokes.length, 1);
});

test("two sweeps in a row do not revoke the same grant twice", async () => {
    const client = makeFakeClient({
        history: [grantMessage({requestId: "r-twice", postedAgoSeconds: 6 * DAY, expiryAgoSeconds: 1 * DAY})]
    });
    const {sweeper, profileManager} = sweeperFor(client);

    await sweeper.runOnce();
    await sweeper.runOnce();

    assert.equal(profileManager.calls.removeUserFromGroup.length, 1);
});

test("one failing revoke does not stop the rest of the sweep", async () => {
    const client = makeFakeClient({
        history: [
            grantMessage({requestId: "r-fails", postedAgoSeconds: 6 * DAY, expiryAgoSeconds: 1 * DAY}),
            grantMessage({requestId: "r-succeeds", postedAgoSeconds: 5 * DAY, expiryAgoSeconds: 1 * HOUR})
        ]
    });
    const {sweeper, profileManager} = sweeperFor(client);

    let first = true;
    const realRemove = profileManager.removeUserFromGroup;
    profileManager.removeUserFromGroup = async (...args) => {
        if (first) {
            first = false;
            throw new Error("Twingate API unavailable");
        }
        return realRemove(...args);
    };

    const result = await sweeper.runOnce();
    assert.equal(result.revoked, 1, "the second grant is still revoked");
    assert.equal(result.failed, 1, "the failure is reported, not swallowed silently");
});
