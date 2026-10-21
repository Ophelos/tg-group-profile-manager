import test from "node:test";
import assert from "node:assert/strict";

import {SelfServeApproval} from "../profileFlows/SelfServeApproval.mjs";
import {handleDmCommand} from "../dmCommands.mjs";

const JIT_GROUP = "Prod ArgoCD — JIT access";   // em-dash, U+2014
const APPROVER_GROUP = "Ophelos Platform Team";
const CHANNEL = "C0ADA18AMHR";

const REQUESTER = {id: "TG_requester", email: "requester@ophelos.com", slackId: "U_requester"};
const APPROVER = {id: "TG_approver", email: "approver@ophelos.com", slackId: "U_approver"};
const OUTSIDER = {id: "TG_outsider", email: "outsider@ophelos.com", slackId: "U_outsider"};

// --- test doubles -----------------------------------------------------------

function tgUser(person, groupNames) {
    return {id: person.id, email: person.email, groups: groupNames.map(name => ({id: `G_${name}`, name}))};
}

function makeFakeClient({failChannelPost = null} = {}) {
    const calls = {postMessage: [], scheduleMessage: [], update: [], lookupByEmail: [], postEphemeral: []};
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
                if (failChannelPost && opts.channel === CHANNEL) {
                    const error = new Error(`An API error occurred: ${failChannelPost}`);
                    error.data = {ok: false, error: failChannelPost};
                    throw error;
                }
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
            },
            postEphemeral: async (opts) => {
                calls.postEphemeral.push(opts);
                return {ok: true};
            }
        }
    };
}

function makeFakeProfileManager() {
    const calls = {addUserToGroup: [], lookUpGroupUsersByName: []};
    return {
        calls,
        lookupGroupByName: async (name) => `G_${name}`,
        lookUpGroupUsersByName: async (name) => {
            calls.lookUpGroupUsersByName.push(name);
            return {name, users: [{id: APPROVER.id, email: APPROVER.email}]};
        },
        lookupUserGroupByEmail: async (email) => {
            if (email === APPROVER.email) return tgUser(APPROVER, ["Everyone", APPROVER_GROUP]);
            return tgUser(REQUESTER, ["Everyone"]);
        },
        addUserToGroup: async (groupId, userId) => {
            calls.addUserToGroup.push([groupId, userId]);
            return {};
        },
        removeUserFromGroup: async () => ({})
    };
}

function makeProfile({approvalChannel = CHANNEL, requesterGroups = ["Everyone"], failChannelPost = null} = {}) {
    const registered = [];
    const app = {
        action: (id, fn) => registered.push(id),
        view: () => {},
        message: () => {},
        refreshHome: async () => {},
        lookupTgUserFromSlackUserId: async (slackUserId) => {
            if (slackUserId === REQUESTER.slackId) return tgUser(REQUESTER, requesterGroups);
            if (slackUserId === APPROVER.slackId) return tgUser(APPROVER, ["Everyone", APPROVER_GROUP]);
            if (slackUserId === OUTSIDER.slackId) return tgUser(OUTSIDER, ["Everyone"]);
            return null;
        }
    };
    const profileEntry = {
        profileName: "Ophelos Production JIT",
        profileType: "selfServeApproval",
        groups: [JIT_GROUP],
        timeOptions: ["1h", "8h", "24h", "7d"],
        applicableToGroup: "Everyone",
        approverGroup: APPROVER_GROUP
    };
    if (approvalChannel) profileEntry.approvalChannel = approvalChannel;
    const profileConfig = {profiles: [profileEntry], groupPermissions: {}};

    const profile = new SelfServeApproval(app, profileConfig, 0);
    const profileManager = makeFakeProfileManager();
    profile.createProfileManager = () => profileManager;
    profileConfig.profiles = [profile];
    return {app, profile, profileConfig, profileManager, client: makeFakeClient({failChannelPost})};
}

const quiet = {error: () => {}, info: () => {}};

function dm(ctx, text, slackUserId = REQUESTER.slackId) {
    return handleDmCommand({text, slackUserId, client: ctx.client, app: ctx.app, profileConfig: ctx.profileConfig, logger: quiet});
}

/** The buttons the approval request ended up with (added by the first chat.update). */
function requestButtons(ctx) {
    return ctx.client.calls.update[0].blocks.find(block => block.type === "actions").elements;
}

function click(ctx, button, slackUserId, channelId = CHANNEL) {
    return ctx.profile.processAccessRequest({
        client: ctx.client,
        body: {
            actions: [{action_id: button.action_id, value: button.value}],
            user: {id: slackUserId},
            channel: {id: channelId}
        },
        logger: quiet,
        ack: async () => {}
    });
}

// --- routing ----------------------------------------------------------------

test("a non-self request is posted once to the approval channel with buttons", async () => {
    const ctx = makeProfile();
    const reply = await dm(ctx, `request "${JIT_GROUP}" 24h deploying a hotfix`);
    assert.match(reply, /sent to the approvers/i);

    const channelPosts = ctx.client.calls.postMessage.filter(m => m.channel === CHANNEL);
    assert.equal(channelPosts.length, 1, "exactly one channel message");
    const text = channelPosts[0].text;
    assert.ok(text.includes(`<@${REQUESTER.slackId}>`), "requester is mentioned");
    assert.ok(text.includes(JIT_GROUP), "group is shown");
    assert.ok(text.includes("24 Hours"), "duration is shown");
    assert.ok(text.includes("deploying a hotfix"), "reason is shown");

    assert.equal(ctx.client.calls.update.length, 1);
    assert.equal(ctx.client.calls.update[0].channel, CHANNEL);
    const buttons = requestButtons(ctx);
    assert.deepEqual(buttons.map(b => b.action_id), ["approve_request-0", "reject_request-0"]);
    assert.deepEqual(JSON.parse(buttons[0].value).approverMessages, [[CHANNEL, "ts_1"]]);

    const requesterMsg = ctx.client.calls.postMessage.find(m => m.channel === REQUESTER.slackId);
    assert.ok(requesterMsg.text.includes(`<#${CHANNEL}>`), "requester is told where it went");

    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, [], "nothing granted before approval");
    assert.equal(ctx.client.calls.scheduleMessage.length, 0);
});

test("no approver is DMed when approvalChannel is set", async () => {
    const ctx = makeProfile();
    await dm(ctx, `request "${JIT_GROUP}" 24h deploying a hotfix`);

    assert.equal(ctx.client.calls.lookupByEmail.length, 0, "approvers are not looked up in Slack");
    assert.equal(ctx.profileManager.calls.lookUpGroupUsersByName.length, 0, "approver group members are not enumerated");
    assert.equal(ctx.client.calls.postMessage.filter(m => m.channel === APPROVER.slackId).length, 0);
    const channels = new Set(ctx.client.calls.postMessage.map(m => m.channel));
    assert.deepEqual([...channels].sort(), [CHANNEL, REQUESTER.slackId].sort());
});

// --- authorisation on click ---------------------------------------------------

test("a click from a non-approver is refused and grants nothing", async () => {
    const ctx = makeProfile();
    await dm(ctx, `request "${JIT_GROUP}" 24h deploying a hotfix`);
    const [approve, reject] = requestButtons(ctx);

    await click(ctx, approve, OUTSIDER.slackId);
    await click(ctx, reject, OUTSIDER.slackId);

    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, []);
    assert.equal(ctx.client.calls.scheduleMessage.length, 0);
    assert.equal(ctx.client.calls.update.length, 1, "the channel message is untouched");
    assert.equal(ctx.client.calls.postEphemeral.length, 2);
    for (const notice of ctx.client.calls.postEphemeral) {
        assert.equal(notice.user, OUTSIDER.slackId);
        assert.equal(notice.channel, CHANNEL);
        assert.ok(notice.text.includes(`Only members of ${APPROVER_GROUP} can approve`));
    }

    // The request is still open: a real approver can still decide it.
    await click(ctx, approve, APPROVER.slackId);
    assert.equal(ctx.profileManager.calls.addUserToGroup.length, 1);
});

test("an unknown Slack user cannot approve", async () => {
    const ctx = makeProfile();
    await dm(ctx, `request "${JIT_GROUP}" 24h deploying a hotfix`);
    await click(ctx, requestButtons(ctx)[0], "U_stranger");
    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, []);
    assert.match(ctx.client.calls.postEphemeral[0].text, /Only members of/);
});

test("the requester cannot approve their own request", async () => {
    // Requester is not an approver at request time; the guard must hold even
    // if they joined the approver group afterwards.
    const ctx = makeProfile();
    await dm(ctx, `request "${JIT_GROUP}" 24h deploying a hotfix`);
    const approve = requestButtons(ctx)[0];
    ctx.app.lookupTgUserFromSlackUserId = async () => tgUser(REQUESTER, ["Everyone", APPROVER_GROUP]);

    await click(ctx, approve, REQUESTER.slackId);
    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, []);
    assert.match(ctx.client.calls.postEphemeral[0].text, /your own access request/);

    // Also refused when the Slack ID differs but it resolves to the same Twingate user.
    await click(ctx, approve, "U_requester_alt");
    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, []);
    assert.match(ctx.client.calls.postEphemeral[1].text, /your own access request/);
});

// --- decision ---------------------------------------------------------------

test("an approver click grants once, updates the channel message, and a second click is a no-op", async () => {
    const ctx = makeProfile();
    await dm(ctx, `request "${JIT_GROUP}" 24h deploying a hotfix`);
    const approve = requestButtons(ctx)[0];

    await click(ctx, approve, APPROVER.slackId);

    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, [[`G_${JIT_GROUP}`, REQUESTER.id]]);
    assert.equal(ctx.client.calls.scheduleMessage.length, 1, "expiry is scheduled through the existing path");
    const grant = ctx.client.calls.postMessage.find(m => typeof m.text === "string" && m.text.startsWith(SelfServeApproval.GRANT_ACCESS_MESSAGE));
    assert.ok(grant, "the catch-up sweep's grant record is written");
    assert.equal(JSON.parse(grant.text.replace(SelfServeApproval.GRANT_ACCESS_MESSAGE, "")).approverSlackId, APPROVER.slackId);

    const decided = ctx.client.calls.update[1];
    assert.equal(decided.channel, CHANNEL);
    assert.equal(decided.ts, "ts_1");
    assert.ok(!decided.blocks.some(b => b.type === "actions"), "buttons are removed");
    assert.ok(decided.text.includes(`\`Approved by\` <@${APPROVER.slackId}> at <!date^`), "approver and time are shown");

    const requesterMsg = ctx.client.calls.postMessage.filter(m => m.channel === REQUESTER.slackId).pop();
    assert.match(requesterMsg.text, /Approved By/, "requester is told the outcome");

    // Second click on the same (stale) button.
    await click(ctx, approve, APPROVER.slackId);
    assert.equal(ctx.profileManager.calls.addUserToGroup.length, 1, "no double grant");
    assert.equal(ctx.client.calls.scheduleMessage.length, 1, "no second expiry");
    assert.equal(ctx.client.calls.update.length, 2);
    assert.match(ctx.client.calls.postEphemeral.pop().text, /already approved by/);
});

test("a rejection updates the channel message and blocks a later approval", async () => {
    const ctx = makeProfile();
    await dm(ctx, `request "${JIT_GROUP}" 24h deploying a hotfix`);
    const [approve, reject] = requestButtons(ctx);

    await click(ctx, reject, APPROVER.slackId);
    const decided = ctx.client.calls.update[1];
    assert.ok(!decided.blocks.some(b => b.type === "actions"));
    assert.ok(decided.text.includes(`\`Rejected by\` <@${APPROVER.slackId}> at <!date^`));
    const requesterMsg = ctx.client.calls.postMessage.filter(m => m.channel === REQUESTER.slackId).pop();
    assert.match(requesterMsg.text, /Rejected By/);

    await click(ctx, approve, APPROVER.slackId);
    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, []);
    assert.match(ctx.client.calls.postEphemeral.pop().text, /already rejected by/);
});

test("a failed grant releases the decision so it can be retried", async () => {
    const ctx = makeProfile();
    await dm(ctx, `request "${JIT_GROUP}" 24h deploying a hotfix`);
    const approve = requestButtons(ctx)[0];

    const realAdd = ctx.profileManager.addUserToGroup;
    ctx.profileManager.addUserToGroup = async () => { throw new Error("Twingate API unavailable"); };
    await assert.rejects(click(ctx, approve, APPROVER.slackId));

    ctx.profileManager.addUserToGroup = realAdd;
    await click(ctx, approve, APPROVER.slackId);
    assert.equal(ctx.profileManager.calls.addUserToGroup.length, 1);
});

// --- self-approval FYI ------------------------------------------------------

test("a self-approved grant posts an FYI without buttons to the approval channel", async () => {
    const ctx = makeProfile({requesterGroups: ["Everyone", APPROVER_GROUP]});
    const reply = await dm(ctx, `request "${JIT_GROUP}" 8h investigating a failed sync`);
    assert.match(reply, /self approving/i);

    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, [[`G_${JIT_GROUP}`, REQUESTER.id]]);
    const fyi = ctx.client.calls.postMessage.filter(m => m.channel === CHANNEL);
    assert.equal(fyi.length, 1);
    assert.ok(fyi[0].text.includes(`<@${REQUESTER.slackId}>`));
    assert.ok(fyi[0].text.includes(JIT_GROUP));
    assert.ok(fyi[0].text.includes("8 Hours"));
    assert.ok(fyi[0].text.includes("investigating a failed sync"));
    assert.match(fyi[0].text, /self-approved/);
    assert.ok(!fyi[0].blocks.some(b => b.type === "actions"), "no buttons on the FYI");
    assert.equal(ctx.client.calls.update.length, 0);
});

test("a failed self-approval FYI does not undo the grant and the requester is told", async () => {
    const ctx = makeProfile({requesterGroups: ["Everyone", APPROVER_GROUP], failChannelPost: "not_in_channel"});
    await dm(ctx, `request "${JIT_GROUP}" 8h investigating a failed sync`);
    assert.equal(ctx.profileManager.calls.addUserToGroup.length, 1);
    const notice = ctx.client.calls.postMessage.filter(m => m.channel === REQUESTER.slackId).pop();
    assert.match(notice.text, /not_in_channel/);
});

// --- channel post failure ---------------------------------------------------

test("a channel post failure is reported to the requester and nothing is granted", async () => {
    const ctx = makeProfile({failChannelPost: "not_in_channel"});

    const reply = await dm(ctx, `request "${JIT_GROUP}" 24h deploying a hotfix`);
    assert.match(reply, /could not be routed/);
    assert.match(reply, /not_in_channel/);
    assert.doesNotMatch(reply, /sent to the approvers/);
    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, []);
    assert.equal(ctx.client.calls.lookupByEmail.length, 0, "no silent fallback to DMs");

    // The App Home modal has no reply channel, so the requester is DMed.
    await ctx.profile.submitAccessRequest({
        client: ctx.client,
        body: {
            user: {id: REQUESTER.slackId},
            view: {
                blocks: [{}, {}, {}],
                state: {values: {
                    b0: {a0: {selected_option: {value: JIT_GROUP}}},
                    b1: {a1: {selected_option: {value: "8 Hours"}}},
                    b2: {a2: {value: "via modal"}}
                }}
            }
        },
        logger: quiet,
        ack: async () => {}
    });
    const modalNotice = ctx.client.calls.postMessage.filter(m => m.channel === REQUESTER.slackId).pop();
    assert.match(modalNotice.text, /could not be routed/);
});

// --- DM mode ----------------------------------------------------------------

test("without approvalChannel the DM flow is unchanged", async () => {
    const ctx = makeProfile({approvalChannel: null});
    const reply = await dm(ctx, `request "${JIT_GROUP}" 24h deploying a hotfix`);
    assert.match(reply, /sent to the approvers/i);

    assert.deepEqual(ctx.client.calls.lookupByEmail, [APPROVER.email]);
    const approverDm = ctx.client.calls.postMessage.find(m => m.channel === APPROVER.slackId);
    assert.ok(approverDm);
    assert.equal(approverDm.text,
        `<@${REQUESTER.slackId}> is requesting access through profile _'Ophelos Production JIT'_.\nGroup: ${JIT_GROUP}\nDuration: 24 Hours (Start from the time of approval)\nReason For Request: deploying a hotfix`);
    assert.equal(ctx.client.calls.postMessage.filter(m => m.channel === CHANNEL).length, 0);
    const requesterMsg = ctx.client.calls.postMessage.find(m => m.channel === REQUESTER.slackId);
    assert.match(requesterMsg.text, /has been sent\.\n/);

    const approve = requestButtons(ctx)[0];
    const payload = JSON.parse(approve.value);
    assert.equal(payload.approverEmail, APPROVER.email);
    assert.equal(payload.approvalChannel, undefined);

    await click(ctx, approve, APPROVER.slackId, APPROVER.slackId);
    assert.equal(ctx.profileManager.calls.addUserToGroup.length, 1);
    assert.equal(ctx.client.calls.update[1].text,
        `<@${REQUESTER.slackId}> is requesting access through profile _'Ophelos Production JIT'_.\nGroup: ${JIT_GROUP}\nDuration: 24 Hours (Start from the time of approval)\nReason For Request: deploying a hotfix \n\`Approved By\` <@${APPROVER.slackId}>`);
});

test("without approvalChannel a self-approval posts no FYI", async () => {
    const ctx = makeProfile({approvalChannel: null, requesterGroups: ["Everyone", APPROVER_GROUP]});
    await dm(ctx, `request "${JIT_GROUP}" 8h quick check`);
    assert.equal(ctx.client.calls.postMessage.filter(m => m.channel === CHANNEL).length, 0);
});

test("DM mode also refuses a click from a non-approver (defence in depth)", async () => {
    const ctx = makeProfile({approvalChannel: null});
    await dm(ctx, `request "${JIT_GROUP}" 24h deploying a hotfix`);
    await click(ctx, requestButtons(ctx)[0], OUTSIDER.slackId, OUTSIDER.slackId);
    assert.deepEqual(ctx.profileManager.calls.addUserToGroup, []);
    assert.match(ctx.client.calls.postEphemeral[0].text, /Only members of/);
});
