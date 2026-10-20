import {SelfServeApproval} from "./profileFlows/SelfServeApproval.mjs";

// Label -> configuration key, e.g. "8 Hours" -> "8h". Used when telling a user
// which durations they can type.
const TIME_OPTION_KEYS = Object.fromEntries(
    Object.entries(SelfServeApproval.TIME_OPTIONS).map(([key, label]) => [label, key])
);

// Slack clients may silently replace straight quotes with typographic ones, so
// normalise them before parsing. Em-dashes are deliberately left alone: they
// occur inside group names.
const QUOTE_CHARS = {
    "‘": "'",  // left single quotation mark
    "’": "'",  // right single quotation mark
    "‚": "'",  // single low-9 quotation mark
    "“": '"',  // left double quotation mark
    "”": '"',  // right double quotation mark
    "„": '"',  // double low-9 quotation mark
    "«": '"',  // left-pointing double angle quotation mark
    "»": '"'   // right-pointing double angle quotation mark
};

export const HELP_TEXT = [
    "*Twingate access requests via direct message*",
    "",
    "`list` - show the groups you can request and the durations allowed for each.",
    "`request <group> <duration> <reason>` - raise an access request.",
    "`help` - show this message.",
    "",
    "*Quoting group names*",
    "Group names that contain spaces must be wrapped in double quotes, for example:",
    "> `request \"Prod ArgoCD — JIT access\" 8h investigating a failed sync`",
    "Type the group name exactly as `list` shows it, em-dash (—) included. Curly quotes are accepted.",
    "An unquoted group name is also accepted when it matches a group you can request.",
    "",
    "*Durations*",
    "Use the short form shown by `list` (for example `1h`, `8h`, `24h`, `7d`), or the long form (`8 Hours`, `7 Days`).",
    "",
    "_Group changes take up to ~20 seconds to reach connected clients._"
].join("\n");

export function normaliseQuotes(text) {
    return String(text).replace(/[‘’‚“”„«»]/g, c => QUOTE_CHARS[c]);
}

// Slack wraps bare URLs/emails in <...> and renders mentions as <@U123>. Strip
// the decoration so a pasted group name still matches.
function stripSlackMarkup(text) {
    return text.replace(/<([^|>]+)\|([^>]*)>/g, "$2").replace(/<([^>]+)>/g, "$1");
}

/**
 * Split a DM into a command verb and its raw argument string.
 * Always returns an object - an empty or unrecognised message yields
 * `command: "unknown"` so the caller can answer with usage text.
 */
export function parseCommand(text) {
    const cleaned = normaliseQuotes(stripSlackMarkup(String(text ?? ""))).trim();
    if (cleaned === "") return {command: "unknown", verb: "", rawArgs: ""};

    const match = cleaned.match(/^(\S+)\s*([\s\S]*)$/);
    const verb = match[1].toLowerCase();
    const rawArgs = match[2].trim();

    switch (verb) {
        case "help":
        case "?":
        case "usage":
            return {command: "help", verb, rawArgs};
        case "list":
        case "ls":
        case "groups":
            return {command: "list", verb, rawArgs};
        case "request":
        case "req":
            return {command: "request", verb, rawArgs};
        default:
            return {command: "unknown", verb, rawArgs};
    }
}

// Compare group names ignoring case and runs of whitespace, so a group name
// retyped with a double space still resolves.
function groupKey(name) {
    return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Pull a group name off the front of `rawArgs`.
 * Quoted names win; otherwise the longest known group name that prefixes the
 * argument string is used.
 * Returns `{group, rest}` or `{error}`.
 */
export function extractGroupName(rawArgs, knownGroupNames) {
    const quote = rawArgs[0];
    if (quote === '"' || quote === "'") {
        const closing = rawArgs.indexOf(quote, 1);
        if (closing === -1) {
            return {error: `The group name is missing its closing ${quote} quote.`};
        }
        return {group: rawArgs.slice(1, closing).trim(), rest: rawArgs.slice(closing + 1).trim()};
    }

    const candidates = [...knownGroupNames].sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
        const prefix = rawArgs.slice(0, candidate.length);
        if (groupKey(prefix) === groupKey(candidate)) {
            const rest = rawArgs.slice(candidate.length);
            // Only a word boundary counts, so "Prod" does not swallow "Prod DB".
            if (rest === "" || /^\s/.test(rest)) {
                return {group: candidate, rest: rest.trim()};
            }
        }
    }

    // Fall back to the first whitespace-delimited token so the caller can
    // report a specific unknown group rather than a generic parse failure.
    const [first = ""] = rawArgs.split(/\s+/);
    return {group: first, rest: rawArgs.slice(first.length).trim(), unmatched: true};
}

/**
 * Parse a duration off the front of `rest`, accepting both the short
 * configuration keys (`8h`, `7d`) and the long labels (`8 Hours`, `7 Days`).
 * Returns `{duration, rest}` (duration is the long label) or `{error}`.
 */
export function extractDuration(rest) {
    if (rest === "") return {error: "No duration was given."};

    const forever = rest.match(/^forever\b\s*([\s\S]*)$/i);
    if (forever) return {duration: "Forever", rest: forever[1].trim()};

    const long = rest.match(/^(\d+)\s+(hours?|days?)\b\s*([\s\S]*)$/i);
    if (long) {
        const unit = long[2].toLowerCase().startsWith("hour") ? "h" : "d";
        const label = SelfServeApproval.TIME_OPTIONS[`${long[1]}${unit}`];
        if (!label) return {error: `Unsupported duration '${long[1]} ${long[2]}'.`};
        return {duration: label, rest: long[3].trim()};
    }

    const short = rest.match(/^(\d+)\s*([hd])\b\s*([\s\S]*)$/i);
    if (short) {
        const label = SelfServeApproval.TIME_OPTIONS[`${short[1]}${short[2].toLowerCase()}`];
        if (!label) return {error: `Unsupported duration '${short[1]}${short[2]}'.`};
        return {duration: label, rest: short[3].trim()};
    }

    const [token] = rest.split(/\s+/);
    return {error: `'${token}' is not a duration.`};
}

/** Durations a profile offers, rendered as the short form a user types. */
export function durationHints(profile) {
    return profile.allowedTimeOptions().map(label => TIME_OPTION_KEYS[label] || label);
}

/** Every selfServeApproval profile this Twingate user is entitled to use. */
export function permittedSelfServeProfiles(profileConfig, tgUser) {
    const userGroupNames = tgUser.groups.map(group => group.name);
    return profileConfig.profiles.filter(profile =>
        profile instanceof SelfServeApproval && userGroupNames.includes(profile.applicableToGroup)
    );
}

function usage(message) {
    return `${message}\n\n${HELP_TEXT}`;
}

function listText(profiles, tgUser) {
    const userGroupNames = tgUser.groups.map(group => group.name);
    const lines = [];

    for (const profile of profiles) {
        const requestable = profile.groups.filter(group => !userGroupNames.includes(group));
        lines.push(`*${profile.profileName}*`);
        if (requestable.length === 0) {
            lines.push("  _You already have every group in this profile._");
        } else {
            const durations = durationHints(profile).join(", ");
            for (const group of requestable) {
                lines.push(`  • \`${group}\` - durations: ${durations}`);
            }
        }
    }

    if (lines.length === 0) {
        return "There are no access profiles available to you.";
    }

    lines.push("", "Request access with: `request \"<group>\" <duration> <reason>`");
    return lines.join("\n");
}

/**
 * Turn one direct message into one reply.
 *
 * Always resolves to a non-empty string: every input, including malformed
 * input and unknown groups, produces a reply. A silent drop is a defect.
 */
export async function handleDmCommand({text, slackUserId, client, app, profileConfig, logger = console}) {
    const parsed = parseCommand(text);

    if (parsed.command === "help") return HELP_TEXT;

    let tgUser;
    try {
        tgUser = await app.lookupTgUserFromSlackUserId(slackUserId);
    } catch (error) {
        logger.error(error);
        return "Sorry, I could not reach Twingate to look up your account. Please try again shortly.";
    }

    if (!tgUser) {
        return "Your Slack email address was not found in Twingate. Please make sure your Slack and Twingate email addresses match.";
    }

    const profiles = permittedSelfServeProfiles(profileConfig, tgUser);

    if (parsed.command === "list") return listText(profiles, tgUser);

    if (parsed.command === "unknown") {
        const said = parsed.verb ? `I did not understand \`${parsed.verb}\`.` : "I did not understand that.";
        return usage(said);
    }

    // parsed.command === "request"
    if (parsed.rawArgs === "") {
        return usage("`request` needs a group, a duration and a reason.");
    }

    const knownGroupNames = [...new Set(profiles.flatMap(profile => profile.groups))];
    const groupResult = extractGroupName(parsed.rawArgs, knownGroupNames);
    if (groupResult.error) return usage(groupResult.error);

    const matchingProfiles = profiles.filter(profile =>
        profile.groups.some(group => groupKey(group) === groupKey(groupResult.group))
    );

    if (matchingProfiles.length === 0) {
        const available = knownGroupNames.length > 0
            ? knownGroupNames.map(name => `\`${name}\``).join(", ")
            : "none";
        return usage(`I do not know a group called \`${groupResult.group}\` that you can request. Groups you can request: ${available}.`);
    }

    const profile = matchingProfiles[0];
    const canonicalGroup = profile.groups.find(group => groupKey(group) === groupKey(groupResult.group));

    const durationResult = extractDuration(groupResult.rest);
    if (durationResult.error) {
        return usage(`${durationResult.error} Durations allowed for \`${canonicalGroup}\`: ${durationHints(profile).join(", ")}.`);
    }

    if (!profile.allowedTimeOptions().includes(durationResult.duration)) {
        return usage(`\`${canonicalGroup}\` cannot be requested for ${durationResult.duration}. Allowed durations: ${durationHints(profile).join(", ")}.`);
    }

    const reason = durationResult.rest;
    if (reason === "") {
        return usage("A reason for the request is required.");
    }

    let result;
    try {
        result = await profile.requestAccess({
            client,
            slackUserId,
            selectedGroup: canonicalGroup,
            selectedTime: durationResult.duration,
            reasonForRequest: reason
        });
    } catch (error) {
        logger.error(error);
        return `Sorry, the request for \`${canonicalGroup}\` failed. Please try again, or use the App Home tab.`;
    }

    if (!result.ok) return result.error;

    // submitRequest already DMs the user the self-approved / pending-approval
    // confirmation, so acknowledge the command without repeating it.
    return result.selfApproved
        ? `Request received - self approving \`${canonicalGroup}\` for ${durationResult.duration}.`
        : `Request received - \`${canonicalGroup}\` for ${durationResult.duration} has been sent to the approvers.`;
}

/**
 * Wire the DM command handler onto a Bolt app.
 *
 * Only plain direct messages from humans are handled. Bot messages are skipped
 * so the bot's own bookkeeping messages (which it posts to its own DM channel
 * because the app runs with `ignoreSelf: false`) do not loop back through here.
 */
export function registerDmCommands(app, profileConfig) {
    app.message(async ({message, say, client, logger}) => {
        try {
            if (message.channel_type !== "im") return;
            if (message.subtype !== undefined) return;
            if (message.bot_id) return;
            if (typeof message.text !== "string") return;
            if (message.text.startsWith("#")) return; // internal bookkeeping markers

            const reply = await handleDmCommand({
                text: message.text,
                slackUserId: message.user,
                client,
                app,
                profileConfig,
                logger: logger || console
            });

            await say({text: reply});
        } catch (error) {
            (logger || console).error(error);
            try {
                await say({text: "Sorry, something went wrong handling that message. Try `help`."});
            } catch (sayError) {
                (logger || console).error(sayError);
            }
        }
    });
}
