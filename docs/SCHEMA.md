
## Profile configuration schema
The schema consists of an object with the following properties:
- _profiles_: List of Object, where each Object defines a Profile
- _groupPermissions_: Dictionary, where each key is a group name and value is a requisite group name for being able to select it. _Optional_.

### Profile:
This object defines a single profile
- _profileName_: String, user-friendly profile name. _Required_.
- _profileType_: Enum, only `oneOf` and `selfServeApproval` supported currently. _Default_: `oneOf`
- _applicableToGroup_: String, a Twingate group that a user must be in for them to see this profile. _Default_: "Everyone"
- _approverGroup_: String, `selfServerApproval` specific, a Twingate group a user must be in for them to approve the access request of the Profile. The group size should not exceed 20 members. _Required_.
- _approvalChannel_: String, `selfServeApproval` specific, the Slack channel ID that receives approval requests instead of DMs to approvers. _Optional_. See [Approval channel](#approval-channel).
- _timeOptions_: Enum, `selfServerApproval` specific, the duration options requesters can select during access request. Must be one of `Forever`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `24h`, `2d`, `3d`,`4d`, `5d`, `6d`, `7d`, `14d`,`21d`,`30d`, `60d`, `90d`. _Default_: `[Forever]`
- _groups_: 
  - _oneOf_: List of String, Twingate groups within the profile which the users can switch between. _Required_.
  - _selfServeApproval_: List of String, Twingate groups within the profile which the users can request access to. _Required_

### Example:
```json
{
  "profiles": [
    {
      "profileName": "Example Profile 1",
      "profileType": "oneOf",
      "groups": [
        "Prod",
        "Preprod",
        "Testing"
      ],
      "applicableToGroup": "Everyone"
    },
    {
      "profileName": "Example Self-Serve Business Approvals",
      "profileType": "selfServeApproval",
      "groups": [
        "HR",
        "Finance",
        "Sales"
      ],
      "timeOptions": ["Forever", "1h", "8h", "24h", "7d", "30d", "90d"],
      "applicableToGroup": "Everyone",
      "approverGroup": "IT"
    }
  ],
  "groupPermissions": {
    "Prod": "Admin"
  }
}
```

In the example above:

**Example Profile 1**
* Any user in the `Everyone` group can access the `Example Profile 1` Profile
* Any user that can access the profile can choose from `Preprod` or `Testing` groups via the Slackbot
* In order to select the `Prod` group a user must _also_ be in the requisite group named `Admin` because of the `groupPermission` object.

**Example Self-Serve Business Approvals**
* Any user in the `Everyone` group can access the `Example Self-Serve Business Approvals` Profile
* Any users that can access the profile can request access to groups `HR`, `Finance` and `Sales`
* Any users that can access the profile can select access duration `Forever`, `1h`, `8h`, `24h`, `7d`, `30d` and `90d`
* The request can be only be approved by the group `IT` members

### Approval channel
Setting `approvalChannel` on a `selfServeApproval` profile sends its approval requests to one Slack channel:

```json
{
  "profileName": "Ophelos Production JIT",
  "profileType": "selfServeApproval",
  "groups": ["Prod ArgoCD — JIT access"],
  "timeOptions": ["1h", "8h", "24h", "7d"],
  "applicableToGroup": "Everyone",
  "approverGroup": "Ophelos Platform Team",
  "approvalChannel": "C0ADA18AMHR"
}
```

* **Invite the bot to the channel** (`/invite @<bot name>`). The bot posts with the `chat:write` scope, which covers public and private channels the bot is a member of. No other scope is needed.
* Anyone in the channel can see the request, but a click is only accepted from a member of `approverGroup`. The bot resolves the clicker's Slack email to their Twingate user and checks their group membership at the time of the click. Everyone else, including the requester, gets an ephemeral refusal and nothing changes. The same check applies to approval DMs when `approvalChannel` is not set.
* The first decision wins. The channel message is updated to show who approved or rejected it and when, and the buttons are removed. A later click on the same request gets an ephemeral "already approved/rejected" notice and grants nothing.
* If the bot cannot post to the channel (for example `not_in_channel` because it has not been invited), nothing is granted, the error is logged, and the requester is told that the request could not be routed. The bot does not fall back to DMs.
