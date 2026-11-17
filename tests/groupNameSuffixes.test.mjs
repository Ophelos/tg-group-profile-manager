import test from "node:test";
import assert from "node:assert/strict";

import {SelfServeApproval} from "../profileFlows/SelfServeApproval.mjs";
import {handleDmCommand} from "../dmCommands.mjs";

const SUFFIX = " self-serve — JIT access";            // leading space, em dash U+2014
const EXACT = "Prod ArgoCD — JIT access";
const SS_TREASURY = `Prod grouptreasury${SUFFIX}`;
const SS_MERLIN = `Prod merlin${SUFFIX}`;
const APPROVER_GROUP = "Ophelos Platform Team";

const REQUESTER = {id: "TG_requester", email: "requester@ophelos.com", slackId: "U_requester"};

const tgUser = (person, groupNames) => ({
    id: person.id,
    email: person.email,
    groups: groupNames.map(name => ({id: `G_${name}`, name}))
});

function makeProfile({suffixes, twingateGroups, listFails = false, requesterGroups = ["Everyone"]}) {
    const registered = [];
    const app = {
        action: (...a) => registered.push(a),
        view: (...a) => registered.push(a),
        message: (...a) => registered.push(a),
        lookupTgUserFromSlackUserId: async () => tgUser(REQUESTER, requesterGroups),
        refreshHome: async () => {}
    };
    const entry = {
        profileName: "Ophelos Production JIT",
        profileType: "selfServeApproval",
        groups: [EXACT],
        timeOptions: ["1h", "8h"],
        applicableToGroup: "Everyone",
        approverGroup: APPROVER_GROUP
    };
    if (suffixes !== undefined) entry.groupNameSuffixes = suffixes;
    const profileConfig = {profiles: [entry], groupPermissions: {}};
    const profile = new SelfServeApproval(app, profileConfig, 0);
    const state = {listCalls: 0, submitted: []};
    profile.createProfileManager = () => ({
        listGroupNames: async () => {
            state.listCalls++;
            if (listFails) throw new Error("twingate unreachable");
            return twingateGroups;
        }
    });
    profile.submitRequest = async (client, group, time, reason) => {
        state.submitted.push({group, time, reason});
        return {routed: true};
    };
    profileConfig.profiles = [profile];
    return {app, profile, profileConfig, state};
}

const dm = (ctx, text) => handleDmCommand({
    text,
    slackUserId: REQUESTER.slackId,
    client: {},
    app: ctx.app,
    profileConfig: ctx.profileConfig,
    logger: {error: () => {}, info: () => {}}
});

const ALL = [EXACT, SS_TREASURY, SS_MERLIN, "Prod Databases", "Platform — Engineering", "self-serve — JIT access"];

test("field absent: only the exact groups, and Twingate is never read", async () => {
    const ctx = makeProfile({twingateGroups: ALL});
    assert.deepEqual(await ctx.profile.resolveGroups(), [EXACT]);
    assert.equal(ctx.state.listCalls, 0);
    const list = await dm(ctx, "list");
    assert.ok(list.includes(EXACT));
    assert.ok(!list.includes(SS_TREASURY));
});

test("suffix: the exact groups plus every group ending with it, read live", async () => {
    const ctx = makeProfile({suffixes: [SUFFIX], twingateGroups: ALL});
    assert.deepEqual(await ctx.profile.resolveGroups(), [EXACT, SS_TREASURY, SS_MERLIN]);
});

test("suffix match is exact: em dash U+2014 only, case-sensitive, something must precede it", async () => {
    const lookalikes = [
        "Prod x self-serve - JIT access",       // hyphen
        "Prod x self-serve – JIT access",       // en dash U+2013
        "Prod x self-serve — jit access",       // case differs
        "self-serve — JIT access",              // nothing before the suffix's leading space
        `${SS_TREASURY} (old)`,                 // suffix is not at the end
        SS_MERLIN
    ];
    const ctx = makeProfile({suffixes: [SUFFIX], twingateGroups: lookalikes});
    assert.deepEqual(await ctx.profile.resolveGroups(), [EXACT, SS_MERLIN]);
});

test("a suffix is never treated as a pattern", async () => {
    const ctx = makeProfile({suffixes: [".*"], twingateGroups: ["Prod x.*", "Prod anything", EXACT]});
    assert.deepEqual(await ctx.profile.resolveGroups(), [EXACT, "Prod x.*"]);
});

test("blank or non-string suffixes are dropped, so they cannot match every group", async () => {
    const ctx = makeProfile({suffixes: ["", "   ", 5, null], twingateGroups: ALL});
    assert.deepEqual(ctx.profile.groupNameSuffixes, []);
    assert.deepEqual(await ctx.profile.resolveGroups(), [EXACT]);
    assert.equal(ctx.state.listCalls, 0);
});

test("a non-array groupNameSuffixes is ignored", async () => {
    const ctx = makeProfile({suffixes: SUFFIX, twingateGroups: ALL});
    assert.deepEqual(await ctx.profile.resolveGroups(), [EXACT]);
});

test("an exact group that also matches the suffix is listed once", async () => {
    const ctx = makeProfile({suffixes: [SUFFIX], twingateGroups: [SS_TREASURY]});
    ctx.profile.groups = [SS_TREASURY];
    assert.deepEqual(await ctx.profile.resolveGroups(), [SS_TREASURY]);
});

test("Twingate unreadable: fails closed to the exact list", async () => {
    const ctx = makeProfile({suffixes: [SUFFIX], twingateGroups: ALL, listFails: true});
    const original = console.error;
    console.error = () => {};
    try {
        assert.deepEqual(await ctx.profile.resolveGroups(), [EXACT]);
    } finally {
        console.error = original;
    }
});

test("`list` shows suffix-matched groups with the profile's durations (no Forever)", async () => {
    const ctx = makeProfile({suffixes: [SUFFIX], twingateGroups: ALL});
    const list = await dm(ctx, "list");
    assert.ok(list.includes(`\`${SS_TREASURY}\` - durations: 1h, 8h`));
    assert.ok(list.includes(`\`${SS_MERLIN}\` - durations: 1h, 8h`));
    assert.ok(!list.includes("Forever"));
    assert.ok(!list.includes("Prod Databases"));
});

test("`request` for a suffix-matched group reaches the normal flow, approver group unchanged", async () => {
    const ctx = makeProfile({suffixes: [SUFFIX], twingateGroups: ALL});
    const reply = await dm(ctx, `request "${SS_TREASURY}" 8h investigating a failed sync`);
    assert.match(reply, /sent to the approvers/);
    assert.deepEqual(ctx.state.submitted, [{group: SS_TREASURY, time: "8 Hours", reason: "investigating a failed sync"}]);
    assert.equal(ctx.profile.approverGroup, APPROVER_GROUP);
});

test("`request` with curly quotes and the em dash resolves the suffix-matched group", async () => {
    const ctx = makeProfile({suffixes: [SUFFIX], twingateGroups: ALL});
    await dm(ctx, `request “${SS_MERLIN}” 1h reason`);
    assert.equal(ctx.state.submitted[0].group, SS_MERLIN);
});

test("`request` for a group that ends with a hyphen look-alike is refused, nothing submitted", async () => {
    const ctx = makeProfile({suffixes: [SUFFIX], twingateGroups: ["Prod x self-serve - JIT access", ...ALL]});
    const reply = await dm(ctx, `request "Prod x self-serve - JIT access" 8h reason`);
    assert.match(reply, /I do not know a group called/);
    assert.deepEqual(ctx.state.submitted, []);
});

test("`request` for a Twingate group that matches no suffix and no exact name is refused", async () => {
    const ctx = makeProfile({suffixes: [SUFFIX], twingateGroups: ALL});
    const reply = await dm(ctx, `request "Prod Databases" 8h reason`);
    assert.match(reply, /I do not know a group called/);
    assert.deepEqual(ctx.state.submitted, []);
});

test("`Forever` is still not offered when timeOptions are configured", async () => {
    const ctx = makeProfile({suffixes: [SUFFIX], twingateGroups: ALL});
    const reply = await dm(ctx, `request "${SS_TREASURY}" forever reason`);
    assert.match(reply, /cannot be requested for Forever/);
    assert.deepEqual(ctx.state.submitted, []);
});

test("requestAccess rejects a group that is neither exact nor suffix-matched", async () => {
    const ctx = makeProfile({suffixes: [SUFFIX], twingateGroups: ALL});
    const result = await ctx.profile.requestAccess({
        client: {}, slackUserId: REQUESTER.slackId, selectedGroup: "Prod Databases", selectedTime: "8 Hours", reasonForRequest: "x"
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /not allowed to access requested group/);
});
