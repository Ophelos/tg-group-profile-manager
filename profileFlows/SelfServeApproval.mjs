import {BaseProfile} from "./BaseProfile.mjs";
import {SlackProfileManager} from "../SlackProfileManager.mjs";
import { v4 as uuidv4 } from 'uuid';
import {claimRevocation, releaseRevocation} from "../revocationGuard.mjs";



export class SelfServeApproval extends BaseProfile {
    static REVOKE_ACCESS_MESSAGE =  "#Duration Access Revoked#";
    static GRANT_ACCESS_MESSAGE =  "#Duration Access Granted#";
    static MESSAGE_TRIGGER = "#Scheduled Message Trigger#"

    // Maps the `timeOptions` keys used in the profile configuration to the
    // human readable labels used everywhere else in the flow (and understood
    // by `durationParser`).
    static TIME_OPTIONS = {
        "Forever" : "Forever",
        "1h": "1 Hour",
        "2h": "2 Hours",
        "4h": "4 Hours",
        "6h": "6 Hours",
        "8h": "8 Hours",
        "12h": "12 Hours",
        "24h": "24 Hours",
        "2d": "2 Days",
        "3d": "3 Days",
        "4d": "4 Days",
        "5d": "5 Days",
        "6d": "6 Days",
        "7d": "7 Days",
        "14d": "14 Days",
        "21d": "21 Days",
        "30d": "30 Days",
        "60d": "60 Days",
        "90d": "90 Days"
    }

    constructor(app, profileConfig, index) {
        const timeOptions = SelfServeApproval.TIME_OPTIONS;
        profileConfig.title = 'Request Access';
        super(app, profileConfig, index)
        this.openModalBlock.blocks[0].text.text = 'Which group would you like to request access to?';
        this.timeOptions = this.timeOptions || [];
        this.timeOptions = this.timeOptions.filter(option => Object.keys(timeOptions).includes(option)).map(option => timeOptions[option])
        this.groups = this.groups || [];
        // Optional Slack channel ID. When set, approval requests are posted to
        // this channel once instead of being DMed to every approver.
        this.approvalChannel = this.approvalChannel || null;
        // Decisions taken on pending requests in this process, keyed by the
        // approval message(s). Guards against a request being approved or
        // rejected twice (two approvers clicking at once, or a stale button).
        this.decisions = new Map();
        // Called when user selects a selfServe profile
        app.action(`select_profile-${index}`, this.selectProfile.bind(this));

        // called when a user submits a selfServer request
        app.view(`submit_profile-${index}`, this.submitAccessRequest.bind(this));

        // called when an approver approves a request
        app.action(`approve_request-${index}`, this.processAccessRequest.bind(this));

        // called when an approver rejects a request
        app.action(`reject_request-${index}`, this.processAccessRequest.bind(this));

        app.message(/^#Scheduled Message Trigger#/, this.scheduledMessageTrigger.bind(this));

    }

    // Single place the Twingate API client is constructed, so the flow can be
    // exercised in tests without reaching the Twingate API.
    createProfileManager() {
        return new SlackProfileManager();
    }

    // Duration labels this profile actually offers. When no `timeOptions` are
    // configured the only valid duration is "Forever" (the modal omits the
    // duration block entirely in that case).
    allowedTimeOptions() {
        return this.timeOptions.length > 0 ? this.timeOptions : ["Forever"];
    }

    async getAppHomeBlock(tgUser) {
        const userGroupNames = tgUser.groups.map(group => group.name);
        const groupOptions = this.groups.filter(group => !userGroupNames.includes(group))
        let currentActiveGroupsString = groupOptions.join(", ")

        const block = {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": `*Profile: ${this.profileName}* (Request Access)\nOptions: ${currentActiveGroupsString}`
            },
            "accessory": {
                "type": "button",
                "action_id": `select_profile-${this.profileIndex}`,
                "style": "primary",
                "text": {
                    "type": "plain_text",
                    "emoji": true,
                    "text": "Request"
                },
                "value": `${this.profileName}`
            }
        }

        if (!currentActiveGroupsString) {
            block.text.text = `*Profile: ${this.profileName}* (Request Access)\nOptions: None`;
            block.accessory.action_id = "has_all_access";
            delete block.accessory.style;
        }

        return block
    }


    async openModal(tgUser) {
        let modal = await super.openModal(tgUser);
        const userGroupNames = tgUser.groups.map(group => group.name)
        // todo: add initial option
        for (const group of this.groups) {
            // skip if the user already in the group
            if (userGroupNames.includes(group)) continue
            const option = {
                text: {
                    type: "plain_text",
                    text: group
                },
                value: group
            }
            modal.blocks[0]["accessory"]["options"].push(option)
        }

        if (this.timeOptions.length > 0) {
            const timeOptionsBlock = {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `How long would you like to request access for?`
                },
                accessory: {
                    type: "static_select",
                    action_id: "change_time_option",
                    options: [],
                    initial_option: {
                        text: {
                            type: "plain_text",
                            text: this.timeOptions[0]
                        },
                        value: this.timeOptions[0]
                    }
                }
            }
            for (const timeOption of this.timeOptions){
                const option = {
                    text: {
                        type: "plain_text",
                        text: timeOption
                    },
                    value: timeOption
                }
                timeOptionsBlock.accessory.options.push(option)
            }
            modal.blocks.push(timeOptionsBlock)
        }



        // reason for request block
        modal.blocks.push({
            type: "input",
            element: {
                type: "plain_text_input",
                multiline: true,
                placeholder: {
                    type: "plain_text",
                    text: "Enter your reason for request."
                },
                max_length: 100
            },
            label: {
                type: "plain_text",
                text: "Reason For Request"
            },
        })
        return modal;
    }

    // Called when user clicks to submit access request
    async submitAccessRequest({client, body, logger, ack}) {
        await ack();
        let selectedOption = ""
        let selectedTime = "Forever"
        let reasonForRequest = ""

        if (body.view.blocks.length === 3) {
            selectedOption = Object.values(Object.values(body.view.state.values)[0])[0].selected_option.value;
            selectedTime = Object.values(Object.values(body.view.state.values)[1])[0].selected_option.value
            reasonForRequest = Object.values(Object.values(body.view.state.values)[2])[0].value;
        } else {
            selectedOption = Object.values(Object.values(body.view.state.values)[0])[0].selected_option.value;
            reasonForRequest = Object.values(Object.values(body.view.state.values)[1])[0].value;
        }

        try {
            const result = await this.requestAccess({
                client,
                slackUserId: body.user.id,
                selectedGroup: selectedOption,
                selectedTime,
                reasonForRequest
            });

            if (!result.ok) {
                logger.error(new Error(result.error));
                // The DM command path replies with result.error itself; the
                // modal has no reply channel, so DM the requester here.
                if (result.routingFailed) {
                    await client.chat.postMessage({channel: body.user.id, text: result.error});
                }
                return;
            }

            await this.app.refreshHome(body.user.id, result.tgUser.email);
        } catch (error) {
            logger.error(error);
        }

    }

    /**
     * The single entry point for submitting an access request.
     *
     * Every surface that can raise a request - the App Home modal
     * (`submitAccessRequest`) and the direct message command handler - must go
     * through here so that authorisation, duration validation, approval
     * routing, expiry scheduling and audit logging stay identical regardless of
     * where the request came from.
     *
     * Returns `{ok: true, tgUser, selfApproved}` on success, or
     * `{ok: false, error}` with a user-presentable reason on refusal. It never
     * throws for an ordinary refusal, so callers can always answer the user.
     */
    async requestAccess({client, slackUserId, selectedGroup, selectedTime, reasonForRequest}) {
        const tgUser = await this.app.lookupTgUserFromSlackUserId(slackUserId);

        if (!tgUser) {
            return {ok: false, error: `Your Slack email address was not found in Twingate. Please make sure your Slack and Twingate email addresses match.`};
        }

        const userGroupNames = tgUser.groups.map(group => group.name);

        // Make sure user is allowed to access profile
        if (!userGroupNames.includes(this.applicableToGroup)) {
            return {ok: false, error: `User '${tgUser.email}' has no access to profile '${this.profileName}'`};
        }

        // Make sure user is allowed to access selected group
        if (typeof selectedGroup === "string" && !this.groups.includes(selectedGroup)) {
            return {ok: false, error: `User '${tgUser.email}' not allowed to access requested group '${selectedGroup}' in profile '${this.profileName}'`};
        }

        // Make sure the profile actually offers the requested duration
        const allowedTimeOptions = this.allowedTimeOptions();
        if (!allowedTimeOptions.includes(selectedTime)) {
            return {ok: false, error: `Duration '${selectedTime}' is not available in profile '${this.profileName}'. Available durations: ${allowedTimeOptions.join(", ")}`};
        }

        const submitted = await this.submitRequest(client, selectedGroup, selectedTime, reasonForRequest, tgUser, slackUserId);

        // The request could not be delivered to the approvers. Report it so the
        // requester is never left waiting on a request nobody can see.
        if (submitted && submitted.routed === false) {
            return {ok: false, error: submitted.error, routingFailed: true, tgUser};
        }

        return {ok: true, tgUser, selfApproved: userGroupNames.includes(this.approverGroup)};
    }

    // Apply selfServe profile change
    async submitRequest(client, selectedGroup, selectedTime, reasonForRequest, tgUser, slackUserId) {
        const profileManager = this.createProfileManager(),
            userGroupNames = tgUser.groups.map(userGroup => userGroup.name),
            groupId = await profileManager.lookupGroupByName(selectedGroup);

        // the user is part of the approver group
        if (userGroupNames.includes(this.approverGroup)){
            let msgOption = ""
            const request = {
                requestId: uuidv4(),
                requestedProfile: this.profileName,
                requestedProfileType: this.profileType,
                requesterTwingateId: tgUser.id,
                requesterEmail: tgUser.email,
                requesterSlackId: slackUserId,
                requestedGroupName: selectedGroup,
                requestedGroupId: groupId,
                reasonForRequest: reasonForRequest,
                approverSlackId: slackUserId,
                selectedTime: selectedTime,
                selfApproval: true
            }
            if (selectedTime !== "Forever") {
                const expiry = this.durationParser(Math.round(Date.now()/1000), selectedTime)
                // todo: test, to be removed
                // const expiry = Math.round(Date.now()/1000)+10
                request.expiry = expiry;

                const botInfo = await client.auth.test()
                await client.chat.postMessage({
                    channel: botInfo.user_id,
                    // channel: "C045BRH55HA",
                    text: `${SelfServeApproval.GRANT_ACCESS_MESSAGE}${JSON.stringify(request)}`,
                })
                await client.chat.scheduleMessage({
                // await client.chat.postMessage({
                    channel: botInfo.user_id,
                    // channel: "C045BRH55HA",
                    text: `${SelfServeApproval.MESSAGE_TRIGGER}${JSON.stringify(request)}`,
                    post_at: expiry
                })
                // console.log(`<@${request.requesterSlackId}> requesting access through profile _'${this.profileName}'_. Group: ${request.requestedGroupName} Duration: ${request.selectedTime} will be expired at '${expiry}'`)
            }

            await profileManager.addUserToGroup(groupId, tgUser.id)
            // console.log(`User '${tgUser.email}' in profile '${this.profileName}' is part of the approver group '${this.approverGroup}', access request through profile ${this.profileName} to group '${selectedGroup}' with duration '${selectedTime}' approved.`);


            const requestObj = (({ requestId, ...o }) => o)(request)
            requestObj.status = "Access Granted"
            console.log(JSON.stringify(requestObj))


            // sending self approved message to user
            let messageString = `The access request through profile _'${this.profileName}'_.\nGroup: ${selectedGroup}\n\`Your access will expire in ${selectedTime}\`\n\`Self Approved\`\n_Note: Group changes will be passed to any connected clients automatically without the need to disconnect and reconnect and this process can take ~20 seconds to pass through to connected clients._`
            msgOption = {
                channel: slackUserId,
                text: messageString,
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: messageString
                        }
                    }
                ]
            }
            await client.chat.postMessage(msgOption)

            // Keep self-approved access visible to the team.
            if (this.approvalChannel) {
                await this.postSelfApprovalNotice(client, request)
            }
            return {routed: true}
        }

        // the user is not part of the approver group
        if (this.approvalChannel) {
            return await this.routeToApprovalChannel(client, {selectedGroup, selectedTime, reasonForRequest, tgUser, slackUserId, groupId})
        }

        const approverGroup = await profileManager.lookUpGroupUsersByName(this.approverGroup)
        let msgOption = {}
        let approverResponses = []
        let approverMessages = []

        for (const approver of approverGroup.users) {
            const approverSlackInfo = await client.users.lookupByEmail({email: approver.email})

            const request = {
                requestId: uuidv4(),
                requestedProfile: this.profileName,
                requestedProfileType: this.profileType,
                approverEmail: approver.email,
                approverGroup: this.approverGroup,
                requesterTwingateId: tgUser.id,
                requesterEmail: tgUser.email,
                requesterSlackId: slackUserId,
                requestedGroupName: selectedGroup,
                requestedGroupId: groupId,
                reasonForRequest: reasonForRequest,
                selectedTime: selectedTime,
                selfApproval: false
            }


            // approver slack message
            let messageString = `<@${slackUserId}> is requesting access through profile _'${this.profileName}'_.\nGroup: ${selectedGroup}\nDuration: ${selectedTime} (Start from the time of approval)\nReason For Request: ${reasonForRequest}`
            msgOption = {
                channel: approverSlackInfo.user.id,
                text: messageString,
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: messageString
                        }
                    }
                ]
            }
            const response = await client.chat.postMessage(msgOption)

            // setting up the msgOption for adding button to the message
            msgOption.ts = response.ts
            msgOption.channel = response.channel
            msgOption.blocks.push(this.approvalActionsBlock(request, slackUserId, selectedGroup, selectedTime))
            approverResponses.push ([response.channel, response.ts])
            approverMessages.push(msgOption)
        }

        // button value has 2000 char limit. without the approverResponse 300 chars, each approver adds around 40 chars + reason for request 150
        if (approverResponses.length > 25) {
            approverResponses = approverResponses.slice(0, 26)
            approverMessages = approverMessages.slice(0, 26)
        }

        // update the message with button which include all the approver message channel and ts
        for (const message of approverMessages){
            const approverEmail = message.blocks[1].elements[0].value.approverEmail
            message.blocks[1].elements.forEach(element => element.value.approverMessages = approverResponses)
            // 40 test
            // message.blocks[1].elements.forEach(element => element.value.approverMessages = [["D0487E9ASPQ","1670342935.338389"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"]])
            // 80 test
            // message.blocks[1].elements.forEach(element => element.value.approverMessages = [["D0487E9ASPQ","1670342935.338389"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D0487E9ASPQ","1670342935.338389"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"],["D048E2M1ZQA","1670342935.681669"]])
            message.blocks[1].elements.forEach(element => element.value = JSON.stringify(element.value))
            await client.chat.update(message)
            // console.log(`User '${tgUser.email}' in profile '${this.profileName}', access request to group '${selectedGroup}' with duration _'${selectedTime}'_ is sent to group member ${approverEmail} from approver group '${this.approverGroup}'.`);
        }

        // requester slack message
        let messageString = `Group access request through profile _'${this.profileName}'_ has been sent.\nGroup: ${selectedGroup}\nDuration: ${selectedTime} (Start from the time of approval)\nA new Slack message will be sent to you once the request is approved/rejected.`
        msgOption = {
            channel: slackUserId,
            text: messageString,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: messageString
                    }
                }
            ]
        }
        await client.chat.postMessage(msgOption)
        const request = {
            requestedProfile: this.profileName,
            requestedProfileType: this.profileType,
            requesterTwingateId: tgUser.id,
            requesterEmail: tgUser.email,
            requesterSlackId: slackUserId,
            requestedGroupName: selectedGroup,
            requestedGroupId: groupId,
            approverGroup: approverGroup.name,
            approverGroupMembers: approverGroup.users.map(user=>user.email),
            reasonForRequest: reasonForRequest,
            selectedTime: selectedTime,
            selfApproval: false,
            status: "Access Pending Approval"
        }
        console.log(JSON.stringify(request))
        return {routed: true}
    };

    // The Approve / Reject buttons attached to an approval request message.
    // `value` is the request payload (an object for the DM flow, which
    // stringifies it later, or an already-stringified payload).
    approvalActionsBlock(value, slackUserId, selectedGroup, selectedTime) {
        const button = (verb, actionPrefix, label, style) => ({
            action_id: `${actionPrefix}-${this.profileIndex}`,
            type: 'button',
            text: {
                type: 'plain_text',
                text: label,
                emoji: true
            },
            style,
            confirm: {
                "title": {
                    "type": "plain_text",
                    "text": "Are you sure?"
                },
                "text": {
                    "type": "mrkdwn",
                    "text": `Are you sure you want to ${verb} the request to add user <@${slackUserId}> to the Twingate group '${selectedGroup}' for '${selectedTime}'?`
                },
                "confirm": {
                    "type": "plain_text",
                    "text": "Confirm"
                },
                "deny": {
                    "type": "plain_text",
                    "text": "Stop, I've changed my mind!"
                }
            },
            value
        });
        return {
            type: 'actions',
            elements: [
                button("APPROVE", "approve_request", "Approve", "primary"),
                button("REJECT", "reject_request", "Reject", "danger")
            ]
        };
    }

    channelRequestText(request) {
        return `<@${request.requesterSlackId}> is requesting access through profile _'${this.profileName}'_.\nGroup: ${request.requestedGroupName}\nDuration: ${request.selectedTime} (Start from the time of approval)\nReason For Request: ${request.reasonForRequest}\n_Only members of ${this.approverGroup} can approve._`
    }

    // Post a non-self-approved request to `approvalChannel` once, with buttons.
    // Returns {routed: true} or {routed: false, error} so the requester is told
    // when the request could not be delivered.
    async routeToApprovalChannel(client, {selectedGroup, selectedTime, reasonForRequest, tgUser, slackUserId, groupId}) {
        const request = {
            requestId: uuidv4(),
            requestedProfile: this.profileName,
            requestedProfileType: this.profileType,
            approverGroup: this.approverGroup,
            approvalChannel: this.approvalChannel,
            requesterTwingateId: tgUser.id,
            requesterEmail: tgUser.email,
            requesterSlackId: slackUserId,
            requestedGroupName: selectedGroup,
            requestedGroupId: groupId,
            reasonForRequest: reasonForRequest,
            selectedTime: selectedTime,
            selfApproval: false
        }
        const messageString = this.channelRequestText(request)
        const section = {type: 'section', text: {type: 'mrkdwn', text: messageString}}

        try {
            const response = await client.chat.postMessage({
                channel: this.approvalChannel,
                text: messageString,
                blocks: [section]
            })
            // The buttons carry the message's own channel/ts so the decision
            // can update it, the same way the DM flow tracks its messages.
            request.approverMessages = [[response.channel, response.ts]]
            await client.chat.update({
                channel: response.channel,
                ts: response.ts,
                text: messageString,
                blocks: [section, this.approvalActionsBlock(JSON.stringify(request), slackUserId, selectedGroup, selectedTime)]
            })
        } catch (error) {
            const reason = (error && error.data && error.data.error) || (error && error.message) || String(error)
            console.error(new Error(`Could not post access request for '${tgUser.email}' to approval channel '${this.approvalChannel}' of profile '${this.profileName}': ${reason}`))
            const requestObj = (({ requestId, ...o }) => o)(request)
            requestObj.status = "Request Routing Failed"
            requestObj.routingError = reason
            console.log(JSON.stringify(requestObj))
            return {
                routed: false,
                error: `Your access request for '${selectedGroup}' could not be routed to the approvers (Slack error: ${reason}). Nothing has been granted. Please tell the platform team, or try again later.`
            }
        }

        // requester slack message
        const requesterString = `Group access request through profile _'${this.profileName}'_ has been sent to <#${this.approvalChannel}> for approval.\nGroup: ${selectedGroup}\nDuration: ${selectedTime} (Start from the time of approval)\nA new Slack message will be sent to you once the request is approved/rejected.`
        await client.chat.postMessage({
            channel: slackUserId,
            text: requesterString,
            blocks: [{type: 'section', text: {type: 'mrkdwn', text: requesterString}}]
        })

        const requestObj = (({ requestId, approverMessages, ...o }) => o)(request)
        requestObj.status = "Access Pending Approval"
        console.log(JSON.stringify(requestObj))
        return {routed: true}
    }

    // FYI to `approvalChannel` when an approver grants themselves access.
    // The grant has already happened, so a failure here is reported, not fatal.
    async postSelfApprovalNotice(client, request) {
        const messageString = `<@${request.requesterSlackId}> self-approved access through profile _'${this.profileName}'_.\nGroup: ${request.requestedGroupName}\nDuration: ${request.selectedTime}\nReason For Request: ${request.reasonForRequest}\n\`Self Approved\``
        try {
            await client.chat.postMessage({
                channel: this.approvalChannel,
                text: messageString,
                blocks: [{type: 'section', text: {type: 'mrkdwn', text: messageString}}]
            })
        } catch (error) {
            const reason = (error && error.data && error.data.error) || (error && error.message) || String(error)
            console.error(new Error(`Could not post self-approval notice for '${request.requesterEmail}' to approval channel '${this.approvalChannel}' of profile '${this.profileName}': ${reason}`))
            try {
                await client.chat.postMessage({
                    channel: request.requesterSlackId,
                    text: `Your access was granted, but the notice to <#${this.approvalChannel}> failed (Slack error: ${reason}). Please let the team know you self-approved '${request.requestedGroupName}'.`
                })
            } catch (e) {
                console.error(e)
            }
        }
    }

    // Reply only to the person who clicked a button.
    async notifyClicker(client, body, text, logger) {
        try {
            if (body.channel && body.channel.id) {
                await client.chat.postEphemeral({channel: body.channel.id, user: body.user.id, text})
            } else {
                await client.chat.postMessage({channel: body.user.id, text})
            }
        } catch (e) {
            logger.error(e)
        }
    }

    // Returns null when the clicker may decide this request, otherwise the
    // reason they may not. Checks the person who clicked, never the payload.
    async approverRefusal(clickerSlackId, request) {
        const onlyApprovers = `Only members of ${this.approverGroup} can approve or reject this request.`
        const ownRequest = "You can't approve or reject your own access request."

        if (clickerSlackId === request.requesterSlackId) return {message: ownRequest, log: `Requester ${clickerSlackId} tried to decide their own request`}

        let clicker = null
        try {
            clicker = await this.app.lookupTgUserFromSlackUserId(clickerSlackId)
        } catch (error) {
            return {message: `${onlyApprovers} Your Twingate account could not be checked, please try again.`, log: `Could not resolve clicker ${clickerSlackId}: ${error && error.message}`}
        }
        if (!clicker) return {message: onlyApprovers, log: `Clicker ${clickerSlackId} not found in Twingate`}

        if (clicker.id === request.requesterTwingateId || clicker.email === request.requesterEmail) {
            return {message: ownRequest, log: `Requester '${clicker.email}' tried to decide their own request`}
        }

        const clickerGroupNames = (clicker.groups || []).map(group => group.name)
        if (!clickerGroupNames.includes(this.approverGroup)) {
            return {message: onlyApprovers, log: `'${clicker.email}' is not in the approver group '${this.approverGroup}' of profile '${this.profileName}'`}
        }
        return null
    }

    // One key per pending request: every approval message (DM or channel)
    // carries the same `approverMessages` list.
    decisionKey(request) {
        const first = Array.isArray(request.approverMessages) && request.approverMessages[0]
        return first ? `${first[0]}:${first[1]}` : request.requestId
    }

    decisionLine(request, verb, slackUserId) {
        if (request.approvalChannel) {
            const now = Math.round(Date.now() / 1000)
            return `\n\`${verb} by\` <@${slackUserId}> at <!date^${now}^{date_short_pretty} {time}|${new Date(now * 1000).toISOString()}>`
        }
        return ` \n\`${verb} By\` <@${slackUserId}>`
    }


    // called when an approver approves or rejects a request
    async processAccessRequest({client, body, logger, ack}) {
        await ack();

        const request = JSON.parse(body.actions[0].value)
        const isReject = body.actions[0].action_id.startsWith("reject_request")

        // Make sure the person who clicked is in the approver group of the
        // profile and is not the requester.
        const refusal = await this.approverRefusal(body.user.id, request)
        if (refusal) {
            logger.error(new Error(refusal.log));
            await this.notifyClicker(client, body, refusal.message, logger);
            return;
        }

        // Only the first decision on a request counts.
        const key = this.decisionKey(request)
        const prior = this.decisions.get(key)
        if (prior) {
            await this.notifyClicker(client, body, `This request was already ${prior.decision} by <@${prior.by}>.`, logger);
            return;
        }
        this.decisions.set(key, {decision: isReject ? "rejected" : "approved", by: body.user.id})

        const progress = {committed: false}
        try {
            const handled = await this.applyDecision({client, body, logger, request, isReject, progress})
            if (!handled) this.decisions.delete(key)
        } catch (error) {
            // Let a later click retry, unless the decision already took effect.
            if (!progress.committed) this.decisions.delete(key)
            throw error
        }
    }

    async applyDecision({client, body, logger, request, isReject, progress = {}}) {
        const profileManager = this.createProfileManager()

        // Make sure requester has profile access
        const requester = await profileManager.lookupUserGroupByEmail(request.requesterEmail);
        const requesterGroupNames = requester.groups.map(group => group.name)
        if (!requesterGroupNames.includes(this.applicableToGroup)) {
            logger.error(new Error(`User '${request.requesterEmail}' has no access to profile '${this.profileName}'`));
            return false;
        }


        let msgOption = {}
        const reasonForRequest = request.reasonForRequest
        const approvers = request.approverMessages

        // request rejected
        if (isReject) {
            progress.committed = true
            // sending all approvers the rejected message
            for (const approver of approvers) {
                try {
                    let messageString = `<@${request.requesterSlackId}> is requesting access through profile _'${this.profileName}'_.\nGroup: ${request.requestedGroupName}\nDuration: ${request.selectedTime} (Start from the time of approval)\nReason For Request: ${reasonForRequest}${this.decisionLine(request, "Rejected", body.user.id)}`
                    msgOption = {
                        channel: approver[0],
                        ts: approver[1],
                        text: messageString,
                        blocks: [
                            {
                                type: 'section',
                                text: {
                                    type: 'mrkdwn',
                                    text: messageString
                                }
                            }
                        ]
                    }
                    await client.chat.update(msgOption)
                } catch(e) {
                    logger.error(e)
                }
            }

            const requestObj = (({ approverMessages, requestId, ...o }) => o)(request)
            // logger.info(`User '${request.requesterEmail}' request to group _'${request.requestedGroupName}'_ with duration _'${request.selectedTime}'_through profile _'${this.profileName}'_ has been rejected by ${body.user.id}.`)
            requestObj.status = "Request Rejected"
            console.log(JSON.stringify(requestObj))

            // sending rejected message to requester
            let messageString = `Access request through profile _'${this.profileName}'_.\nGroup: ${request.requestedGroupName}\nDuration: ${request.selectedTime} (Start from the time of approval)\n\`Rejected By\` <@${body.user.id}>`
            msgOption = {
                channel: request.requesterSlackId,
                text: messageString,
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: messageString
                        }
                    }
                ]
            }
            await client.chat.postMessage(msgOption)
        }

        // request approved
        else {
            const botInfo = await client.auth.test()
            let expiry = "Forever"
            if (request.selectedTime !== "Forever") {
                request.approverSlackId = body.user.id
                expiry = this.durationParser(Math.round(Date.now()/1000), request.selectedTime)
                request.expiry = expiry
                await client.chat.postMessage({
                    channel: botInfo.user_id,
                    text: `${SelfServeApproval.GRANT_ACCESS_MESSAGE}${JSON.stringify(request)}`,
                })
                await client.chat.scheduleMessage({
                // await client.chat.postMessage({
                    channel: botInfo.user_id,
                    // channel: "C045BRH55HA",
                    text: `${SelfServeApproval.MESSAGE_TRIGGER}${JSON.stringify(request)}`,
                    post_at: expiry
                })
                // console.log(`<@${request.requesterSlackId}> requesting access through profile _'${this.profileName}'_. Group: ${request.requestedGroupName} Duration: ${request.selectedTime} will be expired at '${expiry}'`)
            }


            // send the twingate api request
            await profileManager.addUserToGroup(request.requestedGroupId, request.requesterTwingateId)
            progress.committed = true

            // sending all approvers the approved message
            for (const approver of approvers) {
                try {
                    let messageString = `<@${request.requesterSlackId}> is requesting access through profile _'${this.profileName}'_.\nGroup: ${request.requestedGroupName}\nDuration: ${request.selectedTime} (Start from the time of approval)\nReason For Request: ${reasonForRequest}${this.decisionLine(request, "Approved", body.user.id)}`
                    msgOption = {
                        channel: approver[0],
                        ts: approver[1],
                        text: messageString,
                        blocks: [
                            {
                                type: 'section',
                                text: {
                                    type: 'mrkdwn',
                                    text: messageString
                                }
                            }
                        ]
                    }
                    await client.chat.update(msgOption)
                } catch(e) {
                    logger.error(e)
                }
            }


            // // console.log(`User '${request.requesterEmail}' request to group _'${request.requestedGroupName}'_ with duration _'${request.selectedTime}'_ through profile _'${this.profileName}'_ has been approved by ${body.user.id}.`)
            // request.status = "Approved"
            // const requestObj = (({ approverMessages, ...o }) => o)(request)
            // // logger.info(`User '${request.requesterEmail}' request to group _'${request.requestedGroupName}'_ with duration _'${request.selectedTime}'_through profile _'${this.profileName}'_ has been rejected by ${body.user.id}.`)
            // console.log(JSON.stringify(requestObj))


            const requestObj = (({ approverMessages, requestId, ...o }) => o)(request)
            // logger.info(`User '${request.requesterEmail}' request to group _'${request.requestedGroupName}'_ with duration _'${request.selectedTime}'_through profile _'${this.profileName}'_ has been rejected by ${body.user.id}.`)
            requestObj.status = "Access Granted"
            console.log(JSON.stringify(requestObj))

            // sending group change message to requester
            let messageString = `Access request through profile _'${this.profileName}'_.\nGroup: ${request.requestedGroupName}\n\`Your access will expire in ${request.selectedTime}\`\n\`Approved By\` <@${body.user.id}> \n _Note: Group changes will be passed to any connected clients automatically without the need to disconnect and reconnect and this process can take ~20 seconds to pass through to connected clients._`
            msgOption = {
                channel: request.requesterSlackId,
                text: messageString,
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: messageString
                        }
                    }
                ]
            }
            await client.chat.postMessage(msgOption)
        }
        return true
    }

    async scheduledMessageTrigger({event, client, body, context, ack, logger}) {
        const request = JSON.parse(event.text.replace(SelfServeApproval.MESSAGE_TRIGGER, ""))

        // skip if not the profile
        if (request.requestedProfile !== this.profileName) return

        const botInfo = await client.auth.test()

        // confirm the message was sent by the same bot user
        if (event.bot_id !== botInfo.bot_id) {
            console.warn(`Unexpected scheduled message received from user ${event.bot_id}`)
            return
        }

        // The catch-up sweep may already have revoked this grant. Taking the
        // claim here keeps the revoke record, the notifications and the audit
        // lines to exactly one per grant.
        if (!claimRevocation(request.requestId)) return

        // remove user from group through twingate API
        const profileManager = this.createProfileManager()
        try {
            await profileManager.removeUserFromGroup(request.requestedGroupId, request.requesterTwingateId)
        } catch (error) {
            // Hand the claim back so the next sweep retries this grant.
            releaseRevocation(request.requestId)
            throw error
        }

        // post duration access revoked message to self
        await client.chat.postMessage({
            channel: botInfo.user_id,
            text: `${SelfServeApproval.REVOKE_ACCESS_MESSAGE}${JSON.stringify(request)}`,
        })

        // approver message
        let messageString = `<@${request.requesterSlackId}> profile _'${this.profileName}'_ access expired.\nGroup: ${request.requestedGroupName}\nDuration: ${request.selectedTime} (Start from the time of approval)\nReason For Request: ${request.reasonForRequest} \nApproved By <@${request.approverSlackId}>\n\`Access Expired\``
        let msgOption = {
            channel: request.approverSlackId,
            text: messageString,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: messageString
                    }
                }
            ]
        }
        try {
            await client.chat.postMessage(msgOption)
        } catch(e) {
            logger.error(e)
        }

        const requestObj = (({ requestId, ...o }) => o)(request)
        requestObj.status = "Access Expired"
        console.log(JSON.stringify(requestObj))

        if (request.approverSlackId === request.requesterSlackId) return

        // requester message
        messageString = `Profile _'${this.profileName}'_ access expired.\nGroup: ${request.requestedGroupName}\nDuration: ${request.selectedTime} (Start from the time of approval)\nApproved By <@${request.approverSlackId}>\n\`Access Expired\``
        msgOption = {
            channel: request.requesterSlackId,
            text: messageString,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: messageString
                    }
                }
            ]
        }

        try {
            await client.chat.postMessage(msgOption)
        } catch(e) {
            logger.error(e)
        }

    }

    durationParser (timeNow, selectedTime){
        switch (true) {
            case /\d+ Hour(s)?$/.test(selectedTime):
                const hours = selectedTime.split(" ")[0]
                return timeNow + (hours*60*60)
            case /\d+ Day(s)?$/.test(selectedTime):
                const days = selectedTime.split(" ")[0]
                return timeNow + (days*24*60*60)
            default:
                throw `time option '${selectedTime}' format not supported`
        }
    }



}