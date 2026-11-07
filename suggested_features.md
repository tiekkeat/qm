# QM custom-feature requirements

## Purpose and evidence

This document reconstructs the product requirements expressed by the committed changes in `tiekkeat/qm`. It records requirements already evidenced by the fork, rather than proposing an unrelated roadmap. Acceptance criteria below describe the intended product behavior; they are not a claim that every workflow has been verified on the current installation.

Comparison baseline: official `yc-software/qm` main at `76cae911`, the revision integrated in merge `8b2c1723`. Original custom branch: `integration/official-main-20261017` at `9e8c72e2`. Current integration branch: `integration/official-main-20261107`. This comparison is pinned to those revisions, not to future upstream changes.

Evidence comes from fork-only commits, the current difference from that official baseline, feature documentation, and regression tests. Capabilities shared with official QM are included only where the fork extends them. Runtime moves and renamed paths introduced by official QM are not new product features.

## Product objective

Provide a self-hosted organizational AI workspace where people can choose approved execution harnesses, use company or personal model accounts, build reusable agents, connect scoped tools, manage computers, and collaborate on published applications without losing access boundaries or durable state.

Primary users are installation operators, organization administrators, internal members, project owners, application owners, and invited collaborators. External users receive only explicitly granted access.

## Requirements

### F01. Administrator-controlled harnesses and provider credentials

**User need:** Administrators must enable the harnesses available to their organization and manage provider credentials without editing application code.

- Provide Models-page controls for Pi, Codex, Claude Code, and OpenCode.
- Save approved harnesses durably and read the saved selection back into the UI. Clearing the API setting restores deployment defaults; the UI must prevent accidentally disabling every harness.
- Manage built-in provider API keys through write-only controls backed by encrypted storage. Saved keys must never be returned to the browser.
- Apply credential rotation and disabling to new turns across the supported harnesses, including native CLI harnesses.
- Keep harness approval, API-key availability, and subscription-account authorization as separate decisions.
- Preserve Pi **1.0.4** and its maintained provider-error, served-tier, and cancellation behavior during source updates and image builds.

**Acceptance:** Enabling Pi and Codex saves successfully, survives restart, and appears in Settings. Unknown harness IDs are rejected. An administrator cannot change organization approvals through a personal-scope endpoint. Provider errors remain errors rather than successful empty replies.

**Evidence:** `9535b270`, `eadd3a42`, `593b93b9`; `src/api/routes/admin-resources.ts`, `plugins/web-ui/src/admin/settings.ts`, `vendor/pi-ai/`.

### F02. Company, shared, and personal subscription accounts

**User need:** People should be able to use authorized subscriptions without being forced to provide an unrelated organization API key.

- Allow administrators to connect a shared company Codex account and grant or revoke individual access.
- Permit authorized shared Codex use when no OpenAI API key exists; account gates and workspace routing must recognize that authorization.
- Support personal Codex and Claude Code subscriptions, with their own model availability and validation across chat, scheduled work, and runtime changes.
- Preserve the fork’s distinction between personal subscription choices and company-controlled API-key/model policies.
- Share company credential refresh safely across runtimes and preserve native Claude model selections that are not yet in the bundled catalog.
- Allow members to browse authorized workspace content before configuring a model account; explain missing model setup when execution needs it.

**Acceptance:** A granted shared-account user can select Codex without an API key. Revocation blocks subsequent unauthorized use. One person’s credentials are not used for another person’s personal account. Browsing does not require completing model onboarding first.

**Evidence:** `06e3f221`, `a22436ad`, `3ba00134`, `9209108f`, `9f85d572`, `27e3fe33`, `787a3a9d`, `bba0553c`.

### F03. Versioned custom agents

**User need:** People should create reusable specialists and explicitly control which saved version a conversation runs.

- Provide a dedicated Browse → Agents page, chat picker, and `/agent` create/edit/delete/select commands.
- Store agent instructions, copied skills, references, scripts, templates, and examples as versioned packages.
- Support drafts, immutable saved revisions, explicit publishing, revision testing, restore-as-new-version, and optimistic concurrency checks. A no-op save must not create a revision.
- Pin conversations to their chosen version. Adopt a newer published version only through an explicit update. Support workspace defaults, with project defaults controlled by the project owner.
- Support personal/project ownership, recipient use, contributor editing, and improvement suggestions with appropriate permissions.
- Treat package sharing separately from access to files, memory, credentials, MCP connections, or computers.
- Enforce tool restrictions at execution; restricted agents must not escape through delegation, runtime switching, or autonomous background work.
- Make confirmed deletion durable and retryable, remove shared use and defaults, and preserve owner history and unrelated workspace content.

**Acceptance:** A published revision remains unchanged after later edits. A pinned chat continues using it until updated. A recipient can run a shared package without gaining its owner’s credentials. Concurrent conflicting edits are rejected.

**Evidence:** `c2937d87`, `1d91d33b`; [custom-agent specification](docs/features/custom-agents.md).

### F04. Scoped MCP connections and tool permissions

**User need:** People and projects should connect remote tools with explicit control over credentials, recipients, and permitted operations.

- Provide Browse → MCP for personal connections, direct shares, and current project connections.
- Support unauthenticated, bearer, OAuth, and client-credentials authentication. New connections, discovered tools, and unattended access start disabled until approved.
- Provide discovery testing and a searchable, paginated tool-permission dialog with bulk selection and read-only/write classification. Bulk actions must cover all matching tools, not only the current page.
- Share selected tools with an internal person or project using the recipient’s account or an explicitly delegated saved owner account.
- Recheck membership, tool grants, audience, account authorization, and unattended permission on every call. Project connections apply only in their project context.
- Keep credentials encrypted in core; recipients cannot view secrets, edit the connection, or re-share it merely because they can use it.
- Reconnect and reapprove after endpoint/authentication changes. Disconnecting or replacing an account removes saved-account delegations; reconnecting must not silently restore them.
- Support the fork’s administrator-controlled private-endpoint policy consistently across discovery, OAuth, refresh, and execution, while rejecting redirects and checking the actual destination.

**Acceptance:** Revoking a share or project membership blocks the next call. Disabled tools cannot execute. Canceling a permission draft changes nothing. Private-endpoint policy changes affect subsequent requests without deleting saved connections.

**Evidence:** `d0dc2d43`, `1270384d`; [MCP specification](docs/mcp-connectors.md), `test/mcp-project-sharing.test.ts`.

### F05. Personal and project sandbox management

**User need:** People should inspect and manage their computers explicitly, without confusing a machine’s existence with its selection as the default.

- Show scoped computer inventory in Personal and managed projects, including provider, status, supported operations, and default selection.
- Let personal owners create, select/clear defaults, inspect, restart where supported, and retire computers. Project members may inspect; project owners manage project computers.
- Creating a computer must not silently select it. Changing a default must not move running jobs or copy another computer’s disk.
- Preserve containerized-core networking so the local Docker backend can reach its sandbox daemons.
- Report missing, running, parked, and failed states without waking a computer merely to display its status.
- Require confirmation for destructive retirement, preserve saved QM content separately, and expose failed cleanup for retry.

**Acceptance:** Changing a default leaves an existing background job on its original target. A project member cannot retire an owner-managed computer. Status inspection does not provision a replacement.

**Evidence:** `014b2fc6`, `08ef3e60`; [sandbox specification](docs/sandbox-resources.md), `test/sandbox-management.test.ts`.

### F06. Durable project deletion and read-only archives

**User need:** A project owner should be able to remove operational resources without losing the project’s retained records or accidentally destroying independent applications.

- Preview computers, jobs, automations, published apps, and blockers before confirmation.
- Block deletion when serving app revisions/environments still depend on project computers, connections, or project-scoped credentials, or when a provider cannot retire a required computer.
- Freeze the project, disable its background triggers, cancel active turns, retire owned computers, and remove owned MCP connections.
- Transfer independent project-owned apps to the owner’s personal scope while preserving their deployment, data, and existing audience.
- Keep archived chats, saved Files, memory, and registered skill content read-only for the captured eligible members. Exclude archived memory and skills from agent recall/execution.
- Persist cleanup progress and resume authorized deletion after restart, including if the initiating owner is later offboarded. Personal resources remain separate.

**Acceptance:** Interrupted cleanup resumes without repeating destructive work incorrectly. Blocked deletion identifies dependencies. Archived projects cannot accept new writes or be restored through an unsupported workflow.

**Evidence:** `08ef3e60`; `src/projects/project-scope-guard.ts`, `test/project-app-lifecycle.test.ts`, [deletion behavior](docs/sandbox-resources.md#personal-and-project-management).

### F07. Application releases and GitHub collaboration

**User need:** Owners and contributors should review application changes, release versions, collaborate through GitHub, and recover from failed operations.

- Record release metadata, compare versions, audit deployment events, and provide authenticated rollback.
- Support optional private repository creation and linking an existing repository, using verified personal GitHub authorization.
- Support reviewed branch submissions and pull requests, and explicitly confirmed imports of merged changes with durable recovery and retry.
- Keep QM publishing available independently of whether a GitHub review has completed.
- Keep slow connection checks and comparisons separate from mutations so they do not block unrelated controls. Show progress, loading, connection state, and failures.
- Provide responsive detail tabs/dialogs and protect against stale responses or applying an outdated review.
- Preserve executable permissions in published files and surface deployment failures instead of masking them.

**Acceptance:** An owner can compare releases and roll back with an audit trail. Contributors cannot perform owner-only actions. A failed import can be resumed safely. Publishing does not require a GitHub integration.

**Evidence:** `6a0b4dfc`, `bf93a44f`, `8267fe3f`, `319703cb`; `src/deploy/app-github.ts`, `test/app-github.test.ts`, `test/app-collaboration-routes.test.ts`.

### F08. SMTP invitations and password accounts

**User need:** Operators should use their existing email service and provision accounts without depending on a single email vendor.

- Support SMTP alongside Resend and manual invitation links, including sender identity, port, and TLS settings.
- Forward configured SMTP credentials to the component sending invitations; changing deployment secrets must take effect on redeployment.
- Provide administrator-created password accounts and durable password onboarding with configurable login methods and validated signed setup routes.
- Allow initial administrator access through a short-lived, single-use administrator link when email delivery is not configured.
- Keep allowed emails, role grants, password setup, and external-user access distinct.

**Acceptance:** A configured relay can deliver an invitation; an unconfigured relay is identified honestly. Password setup cannot be completed through an unauthorized unsigned request. Generating an administrator link does not create a new administrator grant.

**Evidence:** `27e3fe33`, `050bcd95`; `test/postgres-password-routes.test.ts`, `test/invite-email.test.ts`, `plugins/web-ui/src/admin/password-accounts.ts`.

### F09. Portable local deployment and private app hosting

**User need:** An operator should install and update the customized source on a local machine, including on a private network without public DNS.

- Keep machine configuration and secrets outside the public source checkout, while building the selected source revision and its matching CLI.
- Provide guided installation, prepare/deploy modes, diagnostics, secret generation, repeatable updates, backup verification, and a portable reinstall kit excluding secrets and runtime data.
- Keep Postgres and the core API private; route portal and app traffic through the authenticated front door.
- Serve apps at `https://<app>.apps.<portal-host>` with existing sign-in and sharing checks rather than exposing app containers directly.
- Support private CA certificates for both the portal and wildcard apps before public-IP publication. Export only the public CA certificate for client trust.
- Preserve data and secrets across reruns and enable service restart after reboot. Keep model/email setup explicitly visible when deferred.
- Build without executing the OpenCode binary on the build host; retain dependency audits and runtime compatibility requirements.

**Acceptance:** A second deployment succeeds without losing data. A private installation passes certificate validation using its CA, and an anonymous app request requires sign-in. Source updates retain Pi 1.0.4. Secrets and certificate private keys never enter Git.

**Evidence:** `249ea5cd`, `4a47b1d3`, `608cc89c`, `98c2601c`, `b7572025`, `6fd55f50`, `e904c6d3`; [installation guide](deploy/templates/local-docker-lan/README.md).

### F10. Membership-window restrictions

**User requirement explicitly prioritized during integration:** Preserve the custom branch’s membership-window restrictions.

- Bound shared conversation history by the viewer’s recorded participation intervals; joining must not grant unrestricted earlier history, and leaving must not grant subsequent messages.
- Respect sequence boundaries where present and the recorded time boundaries where sequence bounds are absent. Leaving and rejoining must not fill the intervening gap.
- Apply these bounds consistently to transcript retrieval, visible session discovery/search, and shared snapshots/attachments so an alternate access path cannot bypass them.
- Keep current project membership authoritative for active project operations and triggers. Historical conversation participation alone must not grant current project access.
- Keep archived-project access and write restrictions separate from active membership behavior.

**Acceptance:** Tests cover before-join, during-membership, after-removal, and rejoin cases, including mixed sequence/time bounds and shared snapshots. A source update must not broaden these permissions silently.

**Evidence:** `src/sessions/session-visibility.ts`, `src/sessions/session-participants.ts`, `src/resolution/scope-membership.ts`, `test/session-sharing.test.ts`, `test/projects.test.ts`.

## Integration and validation status

The features above are evidenced in the custom commits and retained implementation, but that is not equivalent to a complete live acceptance run after every merge.

- Local deployment, administrator-link sign-in, basic sandbox execution, restart behavior, deployment conformance, and private portal/wildcard HTTPS have been exercised on this machine.
- The Allowed harness UI exposed a merge regression: the `approved-harnesses` API resource had been dropped although its UI and durable store remained. The resource has now been restored, the admin-resource and runtime-picker regression suites pass, and an authenticated HTTPS request on this installation saved and read back Pi and Codex successfully. The related “Keep current runtime” path now preserves its harness identity.
- Public DNS/public certificate issuance, email delivery, every provider/account combination, and complete end-to-end acceptance of agents, MCP, deletion, and GitHub workflows are not certified by this summary. Earlier commit messages contain historical validation reports; those are not new runs on this installation.
- Retaining custom behavior takes priority during upstream integration, especially Pi 1.0.4 and membership windows. Changes whose behavior cannot be reconciled confidently must be raised with the operator.

## Boundaries

Custom agents are versioned instructions and assets, not model-weight fine-tuning or automatic learning. Sharing one resource does not implicitly share its owner’s other resources. A private-network installation does not require publishing a public IP. This document introduces no new database schema, API design, paid service, or speculative roadmap commitment.
