# Sandbox resources and defaults

A sandbox is an independently recorded resource with an owning scope, provider, backing identity, and lifecycle state. Creating a sandbox provisions a blank machine without copying files or changing a default. Setting a default changes routing only. Background jobs retain the target on which they started.

Sandbox resources are always on. The `sandbox` tool provides lifecycle management; `execute` is the sole command launcher and `background` controls existing processes. `list` returns the available providers and supported actions. Unsupported provider operations fail explicitly. Files publication is separate from sandbox management.

`execute` accepts `sandbox_id` for both foreground and background commands. Without a target, execution requires the scope's stored default. `set_default` accepts an ID or null; null clears the default. A new scope has no default. Retiring a sandbox requires clearing its default and stopping its jobs first. Retirement is available only for providers with direct scope deletion. It never provisions or restores a machine. Once retirement begins, execution stays blocked; interrupted or failed cleanup remains visible and can be retried. Retirement deletes its working state, so durable outputs should be published to Files or git beforehand.

In Isolated posture, agent inventory and operations stay in the current owning scope. In Open posture, authenticated human turns and owner-authorized scheduled turns can also target the acting person's personal sandboxes and Open shared sandboxes where they are a current member. Access is rechecked for each operation; changing conversations does not transfer ownership or grant other participants personal access. Cross-context execution uses the target's existing workspace without copying the calling conversation's credentials, files, or capability tokens onto it. Defaults remain local to their owning scope. Cross-context commands must satisfy both the calling conversation's and target sandbox's command policies. Network access is narrowed to satisfy both egress policies. Provider-native recovery status includes its own expiry; a sandbox record is not an indefinite backup guarantee.

## Agent actions

| Action              | Parameters                                                        |
| ------------------- | ----------------------------------------------------------------- |
| `list`              | `purpose`; returns providers, capabilities, resources and default |
| `create`            | `backend`, optional `name`, `purpose`; creates a blank resource   |
| `set_default`       | `sandbox_id` or null, `purpose`; changes routing                  |
| `status`, `restart` | optional `sandbox_id`, `purpose`                                  |
| `retire`            | `sandbox_id`, `purpose`                                           |

Commands use `execute(command, sandbox_id?, credentials?, background?)`. Set
`background:true` for a detached job and a process ID. The short `purpose` is saved
with the job and displayed instead of the command; the raw command remains available
in expanded output. `timeout_seconds` is the foreground wall-clock timeout or the
background job lifetime. Background jobs require scoped, durable execution; disposable
scratch, owner-auth and reached-room routing remain foreground-only.

The `background` tool controls existing jobs with `poll`, `send_input`, `stop`, `list`,
`watch`, and `unwatch`. Process IDs retain their durable saved target even after the
scope default changes. Watches retain their durable monitor registration and wake this
conversation with output or exit. Provider loss or expiry can still interrupt a process.

Execution and process handlers retain existing command-policy, credential authorization,
and output-screening checks. Strict approvals use the called tool identity (`execute`,
a process action such as `background:poll`, or a lifecycle action such as `sandbox:retire`); a sandbox grant cannot
authorize commands. Transcript entries identify the called tool. Removed sandbox command
and process actions and `background start` are not aliases. No database migration or
backfill is needed; existing jobs remain controllable by process ID. Interrupted old tool calls may return an unsupported-action error and require agent recovery with the new tools.

## Upgrade and rollback

Resources and explicit defaults are always enabled. At startup, a one-time, locked import adopts old routing entries, known session scopes, and provider records. It preserves existing defaults (including an explicit null), resource IDs, and original backing identities. It makes no provider calls or disk copies. Inferred resources start unverified; the completion marker is written last, so an interrupted import can be retried. Before writing adoption state, the import refuses any newly selected default whose provider is not configured, naming the affected scope and provider. Installations with the existing `explicit-defaults` marker have already completed this import.

The old routing table is retained only as upgrade input. It is never read when selecting a computer, and there are no routing-table write or migration endpoints. `SANDBOX_SCOPE_BACKENDS` is accepted only to interpret old bindings during the import; remove it afterwards. `SANDBOX_RESOURCES_ENABLED` no longer changes behavior.

Before upgrading from a release without resource-aware readers, drain its cores and workers. Rollback must use a resource-aware release that honors the permanent completion marker. A missing default after import means no default, not permission to recreate an old scoped computer.

Scoped commands require an explicit target or selected default. Disposable scratch and owner-auth computers use the selected computer's provider without reusing its disk or resource identity; with no selection they use the installation provider, without creating a default. An unavailable selected provider fails explicitly rather than substituting another provider.

To move work between providers, create a computer, restore the required work from git or Files, verify it, and select it as the new default. Selection does not copy files or migrate running jobs.

## Personal and project management

The web UI shows a Sandboxes section in Personal and in managed projects. Inventory is filtered to the page's owning scope. Personal owners can create computers, select or clear their default, inspect status, restart where supported, and retire computers. Project members can inspect inventory and supported status information; only the project owner can manage project computers. The same management permissions apply to chat tools. Creating a computer does not select it as the default.

Retirement confirmation explains that sandbox disk files and installed components are permanently removed. QM saved Files, memory, registered skills, and chats are separate and remain. Retirement blocks new execution, waits for admitted commands, stops registered work on that computer, clears its default if selected, and invokes provider cleanup. Failed cleanup remains visible and retryable. A later chat task can create a replacement computer.

Project owners can delete a project. A preview lists computers, running jobs, automations, published apps, and deletion blockers. Current and serving app revisions and environments are checked for references to project computers, connections, and project-scoped credentials; those dependencies must be moved before deletion. Unsupported computer retirement also blocks deletion. After sandbox and connection cleanup, independent project-owned apps transfer to the owner's personal scope and retain their running deployment, data, and existing audience.

Deletion freezes the project and its membership, disables project-owned background triggers, cancels active turns, retires project-owned computers, and removes project-owned MCP connections. Personal computers and connections are untouched. The final project remains in Archived projects with read-only chats, saved Files, saved memory, and registered skill content for the active members captured when deletion began. Archived memory and skills are excluded from agent recall and execution. Archived projects cannot be restored. Pending cleanup and completed steps are durable; a background sweeper resumes authorized deletion after a restart, including when its initiating owner has since been offboarded.

The user-facing core routes are `GET` and `POST /v1/scopes/:scopeId/sandboxes`, `GET /v1/projects/:id/deletion`, `DELETE /v1/projects/:id`, and `GET /v1/projects/:id/archive`. Mutations bind the authenticated principal and require explicit confirmation for retirement and project deletion. The web surface relays equivalent `/api` routes without accepting a caller-supplied principal.
