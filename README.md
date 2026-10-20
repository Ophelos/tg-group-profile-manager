# tg-group-profile-manager
This repository consists of a Slackbot that allows Twingate users to self-serve access to different groups according to policies defined by their network administrators. In essence, it brings the concept of _profiles_ to Twingate.

Typical use cases:
* Manage access to resources that share the same IP addresses or DNS names
* Segregate access to different environments (e.g. Development, Test, Production environments)
* Switch between resources in different geographic regions
* Request/approve access to groups
* Time-bound access to groups (resources)

Profiles can be configured in JSON and access to each profile can be restricted based on group membership. 

![profile_list](./images/profile_list.png)
![change_group](./images/change_group.png)


## Access expiry

Time-bound access is revoked by a Slack scheduled message that the bot queues at grant time. That delivery is not guaranteed: if the service is down when it fires, Slack retries a few times and then gives up, and the access would never be revoked.

A catch-up sweep is therefore run at startup *and* on an interval. It reads the bot's own DM channel, pairs every `#Duration Access Granted#` record with its `#Duration Access Revoked#` counterpart, and revokes anything that has expired without one.

| Variable | Default | Description |
| --- | --- | --- |
| `EXPIRY_SWEEP_INTERVAL_SECONDS` | `300` | How often the catch-up sweep runs. `0` disables it, leaving expiry dependent solely on Slack scheduled message delivery. |
| `EXPIRY_SWEEP_LOOKBACK_MARGIN_DAYS` | `7` | Headroom above the longest duration any profile can grant. This is effectively the outage the sweep can recover from. |

The look-back window is `max(3 days, longest grantable duration + margin)`, derived from the profiles' `timeOptions`, so adding a longer duration to a profile cannot silently leave grants unsweepable.

The sweep and a delivered scheduled message can both act on the same grant. They are de-duplicated so a grant is revoked, recorded and notified exactly once.
## Direct message commands

As well as the App Home tab, users can drive `selfServeApproval` profiles by sending the bot a direct message. Both surfaces call the same `SelfServeApproval.requestAccess()` function, so authorisation, approval routing, expiry scheduling and audit logging are identical either way.

| Command | Description |
| --- | --- |
| `list` | The groups you may request, and the durations allowed for each. |
| `request <group> <duration> <reason>` | Raise an access request. |
| `help` | Show the commands and the quoting rule. |

Group names that contain spaces must be wrapped in double quotes, and typed exactly as `list` shows them (em-dashes included):

```
request "Prod ArgoCD — JIT access" 8h investigating a failed sync
```

Single quotes and the typographic quotes some Slack clients substitute (`“ ”`, `‘ ’`) are accepted too. An unquoted group name also works when it unambiguously matches a group you can request. Durations accept either the short form used in `timeOptions` (`1h`, `8h`, `24h`, `7d`) or the long label (`8 Hours`, `7 Days`).

Every message to the bot gets a reply: a malformed command, an unknown group or a duration the profile does not offer all return usage text rather than being silently ignored.

To enable this, the Slack app's Messages tab must allow users to send messages (`features.app_home.messages_tab_read_only_enabled: false` in [manifest.yaml](./manifest.yml)), and the `message.im` bot event and `im:history` scope must be present — they already are in the supplied manifest.

## Tests

```shell
npm install
npm test
```

The suite runs on the Node.js built-in test runner and uses no network access.

## Prerequisites
1. Slack Workspace (with admin access to deploy)
2. A [Twingate](https://www.twingate.com/) account
3. Ability to deploy a Slackbot (instructions below)

## Install Steps
### Create and setup Slack App
1. Create New Slack app from a manifest [here](https://api.slack.com/apps)
2. Paste the content from [manifest.yaml](./manifest.yml)
3. Install the Slack app to your Workspace
4. Retrieve the _signing secret_ from the `Basic Information` page and _bot token_ from `OAuth & Permissions` page

### Configuration
Please prepare the following configuration parameters (refer to the [example file](./tg-group-profile-manager.conf)):
 - `SLACK_SIGNING_SECRET` Slack signing secret
 - `SLACK_BOT_TOKEN` Slack bot token (begins with `xoxb-`)
 - `TG_API_KEY` can be generated in the Setting page within the Twingate Admin Console (Read and Write permission is required)
 - `TG_ACCOUNT` replace with your Twingate Network Address (e.g. _test1.twingate.com_)
 - `PROFILE_CONFIG` Your profile configuration (see notes and guidance in the [schema documentation](./docs/SCHEMA.md))

### Deploy on Google CloudRun (CloudRun Button)
1. Ensure you have the following pre-requisites:
    - All configuration parameters from the `Configuration` section above
    - `PROJECT_ID` GCP Project (will be passed to container for it to access secrets)
    - Google Cloud project owner
2. Click and follow the steps in GCP CloudShell, entering the configuration parameters when prompted:

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run?git_repo=https://github.com/Twingate-Labs/tg-group-profile-manager)

The `Run on Google Cloud option` will prompt for all pre-requisite parameters during setup and store them as secrets. For a full description of the executed steps please see [`app.json`](./app.json).

For a manual deployment you may instead follow the [manual instructions](./docs/MANUAL_DEPLOYMENT.md) 

### Complete setup in Slack App UI
1. Go to your app at [Slack App UI](https://api.slack.com/apps)
3. Event Subscription
   * Replace the Request URL to `https://{Your tg-group-profile-manager URL}/slack/events`
* Interactivity & Shortcuts
   * Replace the Request URL to `https://{Your tg-group-profile-manager URL}/slack/events`
4. Download the [Twingate Logo](./Twingate%20Logo%20-%20Icon.png) and change the logo of the Slack app in the `Basic Info` page.

### Current limitations & known issues
1. When there are Twingate groups with duplicate names, only the first group returned by the Twingate API is used. To prevent this, ensure there are no duplicate group names in the Twingate network.
2. Only support native Twingate groups and does not support groups synced from IdP
3. The Slack users' email addresses needs to be the same as their Twingate email address.
4. Group changes will be passed to any connected clients automatically without the need to disconnect and reconnect but please advise end-users that this process can take ~20 seconds to pass through to connected clients.