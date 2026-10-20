import test from "node:test";
import assert from "node:assert/strict";

import {SelfServeApproval} from "../profileFlows/SelfServeApproval.mjs";
import {
    handleDmCommand,
    parseCommand,
    extractGroupName,
    extractDuration,
    normaliseQuotes,
    HELP_TEXT
} from "../dmCommands.mjs";

const JIT_GROUP = "Prod ArgoCD — JIT access";   // em-dash, U+2014
const DB_GROUP = "Prod Databases";
const APPROVER_GROUP = "Ophelos Platform Team";

const REQUESTER = {
    id: "TG_requester",
    email: "requester@ophelos.com",
    slackId: "U_requester"
};
const APPROVER = {
    id: "TG_approver",
    email: "approver@ophelos.com",
    slackId: "U_approver"
};

// --- test doubles -----------------------------------------------------------

function makeFakeApp() {
    const registered = {actions: [], views: [], messages: []};
    return {
        registered,
        action: (id, fn) => registered.actions.push([id, fn]),
        view: (id, fn) => registered.views.push([id, fn]),
        message: (...args) => registered.messages.push(args),
        lookupTgUserFromSlackUserId: async () => null,   // overridden per test
        refreshHome: async () => {}
    };
}

function makeFakeClient() {
    const calls = {postMessage: [], scheduleMessage: [], update: [], lookupByEmail: []};
    return {
        calls,
        auth: {test: async () => ({user_id: "U_bot", bot_id: "B_bot"})},
        users: {
            lookupByEmail: async ({email}) => {
                calls.lookupByEmail.push(email);
                return {user: {id: email === APPROVER.email ? APPROVER.slackId : `U_${email}`}};
            }
        },
        chat: {
            postMessage: async (opts) => {
                calls.postMessage.push(opts);
                return {ts: `ts_${calls.postMessage.length}`, channel: opts.channel};
            },
            scheduleMessage: async (opts) => {
                calls.scheduleMessage.push(opts);
                return {scheduled_message_id: "Q1"};
            },
            update: async (opts) => {
                calls.update.push(opts);
                return {ok: true};
            }
        }
    };
}

function makeFakeProfileManager() {
    const calls = {addUserToGroup: [], removeUserFromGroup: []};
    return {
        calls,
        lookupGroupByName: async (name) => `G_${name}`,
        lookUpGroupUsersByName: async (name) => ({
            name,
            users: [{id: APPROVER.id, email: APPROVER.email}]
        }),
        lookupUserGroupByEmail: async (email) => {
            if (email === APPROVER.email) return tgUser(APPROVER, ["Everyone", APPROVER_GROUP]);
            return tgUser(REQUESTER, ["Everyone"]);
        },
        addUserToGroup: async (groupId, userId) => {
            calls.addUserToGroup.push([groupId, userId]);
            return {};
        },
        removeUserFromGroup: async (groupId, userId) => {
            calls.removeUserFromGroup.push([groupId, userId]);
            return {};
        }
    };
}

function tgUser(person, groupNames) {
    return {
        id: person.id,
        email: person.email,
        groups: groupNames.map(name => ({id: `G_${name}`, name}))
    };
}

/**
 * Build a SelfServeApproval wired to test doubles, matching the configuration
 * intended for the Ophelos deployment (no "Forever").
 */
function makeProfile({requesterGroups = ["Everyone"]} = {}) {
    const app = makeFakeApp();
    const profileConfig = {
        profiles: [{
            profileName: "Ophelos Production JIT",
            profileType: "selfServeApproval",
            groups: [JIT_GROUP, DB_GROUP],
            timeOptions: ["1h", "8h", "24h", "7d"],
            applicableToGroup: "Everyone",
            approverGroup: APPROVER_GROUP
        }],
        groupPermissions: {}
    };

    const profile = new SelfServeApproval(app, profileConfig, 0);
    const profileManager = makeFakeProfileManager();
    profile.createProfileManager = () => profileManager;

    app.lookupTgUserFromSlackUserId = async (slackUserId) => {
        if (slackUserId === REQUESTER.slackId) return tgUser(REQUESTER, requesterGroups);
        if (slackUserId === APPROVER.slackId) return tgUser(APPROVER, ["Everyone", APPROVER_GROUP]);
        return null;
    };

    profileConfig.profiles = [profile];
    return {app, profile, profileConfig, profileManager, client: makeFakeClient()};
}

function dm(ctx, text, slackUserId = REQUESTER.slackId) {
    return handleDmCommand({
        text,
        slackUserId,
        client: ctx.client,
        app: ctx.app,
        profileConfig: ctx.profileConfig,
        logger: {error: () => {}, info: () => {}}
    });
}

// --- parser units -----------------------------------------------------------

test("normaliseQuotes converts curly quotes but preserves em-dashes", () => {
    assert.equal(normaliseQuotes("“Prod — JIT”"), '"Prod — JIT"');
    assert.equal(normaliseQuotes("Prod — JIT"), "Prod — JIT");
});

test("parseCommand recognises the three verbs and flags anything else", () => {
    assert.equal(parseCommand("list").command, "list");
    assert.equal(parseCommand("  HELP  ").command, "help");
    assert.equal(parseCommand("request x 1h why").command, "request");
    assert.equal(parseCommand("delete everything").command, "unknown");
    assert.equal(parseCommand("").command, "unknown");
    assert.equal(parseCommand("   ").command, "unknown");
});

test("extractGroupName handles double, single and curly quoted names with em-dashes", () => {
    const known = [JIT_GROUP, DB_GROUP];

    const dq = extractGroupName(`"${JIT_GROUP}" 8h because`, known);
    assert.equal(dq.group, JIT_GROUP);
    assert.equal(dq.rest, "8h because");

    const sq = extractGroupName(`'${JIT_GROUP}' 8h because`, known);
    assert.equal(sq.group, JIT_GROUP);

    const curly = extractGroupName(normaliseQuotes(`“${JIT_GROUP}” 8h because`), known);
    assert.equal(curly.group, JIT_GROUP);

    const unquoted = extractGroupName(`${JIT_GROUP} 8h because`, known);
    assert.equal(unquoted.group, JIT_GROUP);
    assert.equal(unquoted.rest, "8h because");

    const unterminated = extractGroupName(`"${JIT_GROUP} 8h because`, known);
    assert.match(unterminated.error, /closing/);
});

test("extractGroupName prefers the longest matching group name", () => {
    const known = ["Prod", "Prod Databases"];
    assert.equal(extractGroupName("Prod Databases 8h why", known).group, "Prod Databases");
    assert.equal(extractGroupName("Prod 8h why", known).group, "Prod");
});

test("extractDuration accepts short keys and long labels", () => {
    assert.equal(extractDuration("8h a reason").duration, "8 Hours");
    assert.equal(extractDuration("8 Hours a reason").duration, "8 Hours");
    assert.equal(extractDuration("1h a reason").duration, "1 Hour");
    assert.equal(extractDuration("7d a reason").duration, "7 Days");
    assert.equal(extractDuration("7 days a reason").duration, "7 Days");
    assert.equal(extractDuration("forever a reason").duration, "Forever");
    assert.equal(extractDuration("8h a reason").rest, "a reason");
    assert.match(extractDuration("soon a reason").error, /not a duration/);
    assert.match(extractDuration("").error, /No duration/);
});

// --- list -------------------------------------------------------------------

test("list shows requestable groups with their allowed durations", async () => {
    const ctx = makeProfile();
    const reply = await dm(ctx, "list");

    assert.match(reply, /Ophelos Production JIT/);
    assert.ok(reply.includes(JIT_GROUP), "em-dash group name is listed verbatim");
    assert.ok(reply.includes(DB_GROUP));
    assert.match(reply, /1h, 8h, 24h, 7d/);
    assert.ok(!/Forever/.test(reply), "Forever is not offered by this profile");
});

test("list omits groups the user already holds", async () => {
    const ctx = makeProfile({requesterGroups: ["Everyone", DB_GROUP]});
    const reply = await dm(ctx, "list");

    assert.ok(reply.includes(JIT_GROUP));
    assert.ok(!reply.includes(`\`${DB_GROUP}\``), "already-held group is hidden");
});

test("list for an unknown Twingate user explains the email mismatch", async () => {
    const ctx = makeProfile();
    const reply = await dm(ctx, "list", "U_stranger");
    assert.match(reply, /not found in Twingate/);
});

// --- request: self-approval -------------------------------------------------

test("request self-approves when the requester is in the approver group", async () => {
    const ctx = makeProfile({requesterGroups: ["Everyone", APPROVER_GROUP]});
    const reply = await dm(ctx, `request "${JIT_GROUP}" 8h investigating a failed sync`);

    assert.match(reply, /self approving/i);
    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, [[`G_${JIT_GROUP}`, REQUESTER.id]]);

    // No approver was contacted.
    assert.equal(ctx.client.calls.lookupByEmail.length, 0);

    const confirmation = ctx.client.calls.postMessage.find(m => m.channel === REQUESTER.slackId);
    assert.ok(confirmation, "requester receives a confirmation DM");
    assert.match(confirmation.text, /Self Approved/);
    assert.ok(confirmation.text.includes(JIT_GROUP));
});

test("request self-approved schedules the expiry and records the grant", async () => {
    const ctx = makeProfile({requesterGroups: ["Everyone", APPROVER_GROUP]});
    const before = Math.round(Date.now() / 1000);
    await dm(ctx, `request "${JIT_GROUP}" 8h investigating a failed sync`);
    const after = Math.round(Date.now() / 1000);

    assert.equal(ctx.client.calls.scheduleMessage.length, 1, "exactly one expiry is scheduled");
    const scheduled = ctx.client.calls.scheduleMessage[0];
    assert.equal(scheduled.channel, "U_bot", "expiry trigger is scheduled into the bot's own DM");
    assert.ok(scheduled.text.startsWith(SelfServeApproval.MESSAGE_TRIGGER));
    assert.ok(scheduled.post_at >= before + 8 * 3600 && scheduled.post_at <= after + 8 * 3600,
        `post_at ${scheduled.post_at} should be ~8h from now`);

    // The startup catch-up sweep depends on this bookkeeping message.
    const grant = ctx.client.calls.postMessage.find(
        m => typeof m.text === "string" && m.text.startsWith(SelfServeApproval.GRANT_ACCESS_MESSAGE));
    assert.ok(grant, "a #Duration Access Granted# record is posted to the bot's own DM");
    const record = JSON.parse(grant.text.replace(SelfServeApproval.GRANT_ACCESS_MESSAGE, ""));
    assert.equal(record.requestedGroupName, JIT_GROUP);
    assert.equal(record.selectedTime, "8 Hours");
    assert.equal(record.selfApproval, true);
    assert.equal(record.expiry, scheduled.post_at,
        "the catch-up record and the scheduled trigger agree on the expiry");
});

// --- request: pending approval ----------------------------------------------

test("request from a non-approver goes to the approvers and grants nothing yet", async () => {
    const ctx = makeProfile();
    const reply = await dm(ctx, `request "${JIT_GROUP}" 24h deploying a hotfix`);

    assert.match(reply, /sent to the approvers/i);
    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, [], "no access is granted before approval");
    assert.equal(ctx.client.calls.scheduleMessage.length, 0, "no expiry is scheduled before approval");

    const approverDm = ctx.client.calls.postMessage.find(m => m.channel === APPROVER.slackId);
    assert.ok(approverDm, "the approver is DMed");
    assert.match(approverDm.text, /deploying a hotfix/);

    const buttons = ctx.client.calls.update[0].blocks[1].elements;
    assert.equal(buttons[0].action_id, "approve_request-0");
    assert.equal(buttons[1].action_id, "reject_request-0");
});

// --- approve / reject -------------------------------------------------------

/** Run a DM request, then hand the approver's button payload back to the app. */
async function approveOrReject(ctx, actionIndex) {
    await dm(ctx, `request "${JIT_GROUP}" 24h deploying a hotfix`);
    const buttons = ctx.client.calls.update[0].blocks[1].elements;
    const button = buttons[actionIndex];

    await ctx.profile.processAccessRequest({
        client: ctx.client,
        body: {actions: [{action_id: button.action_id, value: button.value}], user: {id: APPROVER.slackId}},
        logger: {error: () => {}},
        ack: async () => {}
    });
    return JSON.parse(button.value);
}

test("approve grants the group, schedules expiry and notifies both parties", async () => {
    const ctx = makeProfile();
    const before = Math.round(Date.now() / 1000);
    const request = await approveOrReject(ctx, 0);
    const after = Math.round(Date.now() / 1000);

    assert.equal(request.requestedGroupName, JIT_GROUP, "em-dash survives the JSON button round-trip");
    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, [[`G_${JIT_GROUP}`, REQUESTER.id]]);

    assert.equal(ctx.client.calls.scheduleMessage.length, 1);
    const scheduled = ctx.client.calls.scheduleMessage[0];
    assert.ok(scheduled.post_at >= before + 24 * 3600 && scheduled.post_at <= after + 24 * 3600);

    const requesterMsg = ctx.client.calls.postMessage.filter(m => m.channel === REQUESTER.slackId).pop();
    assert.match(requesterMsg.text, /Approved By/);
    const approverMsg = ctx.client.calls.update.pop();
    assert.match(approverMsg.text, /Approved By/);
});

test("reject grants nothing, schedules nothing and tells the requester", async () => {
    const ctx = makeProfile();
    await approveOrReject(ctx, 1);

    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, []);
    assert.equal(ctx.client.calls.scheduleMessage.length, 0);

    const requesterMsg = ctx.client.calls.postMessage.filter(m => m.channel === REQUESTER.slackId).pop();
    assert.match(requesterMsg.text, /Rejected By/);
});

// --- expiry -----------------------------------------------------------------

test("the scheduled expiry trigger revokes the group membership", async () => {
    const ctx = makeProfile({requesterGroups: ["Everyone", APPROVER_GROUP]});
    await dm(ctx, `request "${JIT_GROUP}" 1h quick check`);
    const scheduled = ctx.client.calls.scheduleMessage[0];

    await ctx.profile.scheduledMessageTrigger({
        event: {text: scheduled.text, bot_id: "B_bot"},
        client: ctx.client,
        logger: {error: () => {}}
    });

    assert.deepEqual(ctx.profileManager.calls.removeUserFromGroup, [[`G_${JIT_GROUP}`, REQUESTER.id]]);
    const revoke = ctx.client.calls.postMessage.find(
        m => typeof m.text === "string" && m.text.startsWith(SelfServeApproval.REVOKE_ACCESS_MESSAGE));
    assert.ok(revoke, "a #Duration Access Revoked# record closes the catch-up loop");
});

// --- malformed input and unknown groups -------------------------------------

test("unknown group is refused with usage text and the list of valid groups", async () => {
    const ctx = makeProfile();
    const reply = await dm(ctx, 'request "Prod Kubernetes" 8h poking around');

    assert.match(reply, /do not know a group/i);
    assert.ok(reply.includes(JIT_GROUP), "valid groups are offered");
    assert.ok(reply.includes("request <group> <duration> <reason>"));
    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, []);
});

test("a duration the profile does not offer is refused", async () => {
    const ctx = makeProfile();
    const forever = await dm(ctx, `request "${JIT_GROUP}" forever because I want it`);
    assert.match(forever, /cannot be requested for Forever/);

    const notOffered = await dm(ctx, `request "${JIT_GROUP}" 30d because I want it`);
    assert.match(notOffered, /cannot be requested for 30 Days/);

    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, []);
});

test("a missing reason is refused", async () => {
    const ctx = makeProfile();
    const reply = await dm(ctx, `request "${JIT_GROUP}" 8h`);
    assert.match(reply, /reason for the request is required/i);
    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, []);
});

test("help explains the quoting rule and the em-dash", async () => {
    const ctx = makeProfile();
    const reply = await dm(ctx, "help");
    assert.equal(reply, HELP_TEXT);
    assert.match(reply, /double quotes/);
    assert.ok(reply.includes("—"), "the em-dash is shown in the worked example");
});

test("no input is ever silently dropped", async () => {
    const ctx = makeProfile();
    const inputs = [
        "", "   ", "\n", "hello", "request", "request ", "requests", "LIST",
        `request "${JIT_GROUP}"`,
        `request "${JIT_GROUP} 8h unterminated quote`,
        "request 8h no group at all",
        `request ${JIT_GROUP} banana reason`,
        "?!*", "list extra words", "help me", "“list”",
        "request '' 8h empty group"
    ];

    for (const input of inputs) {
        const reply = await dm(ctx, input);
        assert.equal(typeof reply, "string", `no reply for ${JSON.stringify(input)}`);
        assert.ok(reply.trim().length > 0, `empty reply for ${JSON.stringify(input)}`);
    }

    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, [],
        "none of the malformed inputs granted access");
});

// --- the shared path --------------------------------------------------------

test("the DM path calls the same requestAccess/submitRequest used by the modal", async () => {
    const ctx = makeProfile({requesterGroups: ["Everyone", APPROVER_GROUP]});

    const seen = {requestAccess: 0, submitRequest: 0};
    const realRequestAccess = ctx.profile.requestAccess.bind(ctx.profile);
    const realSubmitRequest = ctx.profile.submitRequest.bind(ctx.profile);
    ctx.profile.requestAccess = async (...args) => {
        seen.requestAccess += 1;
        return realRequestAccess(...args);
    };
    ctx.profile.submitRequest = async (...args) => {
        seen.submitRequest += 1;
        return realSubmitRequest(...args);
    };

    await dm(ctx, `request "${JIT_GROUP}" 8h via dm`);
    assert.deepEqual(seen, {requestAccess: 1, submitRequest: 1});

    // The modal path reaches the same two functions.
    await ctx.profile.submitAccessRequest({
        client: ctx.client,
        body: {
            user: {id: REQUESTER.slackId},
            view: {
                blocks: [{}, {}, {}],
                state: {
                    values: {
                        b0: {a0: {selected_option: {value: DB_GROUP}}},
                        b1: {a1: {selected_option: {value: "8 Hours"}}},
                        b2: {a2: {value: "via modal"}}
                    }
                }
            }
        },
        logger: {error: () => {}},
        ack: async () => {}
    });
    assert.deepEqual(seen, {requestAccess: 2, submitRequest: 2});

    // Both entry points produced an identical shape of grant.
    const grants = ctx.client.calls.postMessage
        .filter(m => typeof m.text === "string" && m.text.startsWith(SelfServeApproval.GRANT_ACCESS_MESSAGE))
        .map(m => JSON.parse(m.text.replace(SelfServeApproval.GRANT_ACCESS_MESSAGE, "")));

    assert.equal(grants.length, 2);
    assert.deepEqual(Object.keys(grants[0]).sort(), Object.keys(grants[1]).sort());
    assert.equal(grants[0].requestedGroupName, JIT_GROUP);
    assert.equal(grants[1].requestedGroupName, DB_GROUP);
    assert.equal(ctx.client.calls.scheduleMessage.length, 2);
});
