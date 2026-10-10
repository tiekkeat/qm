# Custom agents

Browse → Agents manages personal and project instruction packages. Ask QM in normal chat to create or improve a specialist, or use `/agent create <description>`, `/agent edit <slug> <change>`, and `/agent delete <slug>`. The seeded agent-management skill and native agents tool use the same backend as the UI.

A package contains Markdown instructions, copied skill snapshots, references, scripts, templates, and task/expected-output examples. Metadata, immutable revision records, suggestions, selections, defaults, and sharing live in Postgres. Package contents live in the configured durable file-byte store. There is no model-weight fine-tuning or automatic learning.

Create a draft, save changes as new versions, test a saved version in chat, and publish explicitly. A no-op save creates no revision. Concurrent edits require the expected latest version; reload and reconcile conflicts. Restoring copies an earlier package into a new revision. Publishing never creates a revision.

Select a published agent in the chat dropdown or with `/agent <slug> [task]`. `/agent default` resets to Default QM. Conversations pin their saved selection; Update explicitly adopts the current published release. Workspace defaults apply to new conversations. Project defaults require the project owner. Every executed turn records the selected agent and revision in its user entry.

The owner controls sharing and deletion. Project creators and project owners can edit by default; other project members can use published versions. User recipients can read and run published packages and propose improvements. Contributors can also edit and publish. Drafts and suggestions stay visible to editors. Sharing a package grants no workspace files, memory, credentials, MCP connections, or sandbox access.

Tools remain subject to workspace and organization permissions. Agent restrictions can narrow native/MCP access, including individual native actions such as files.read. An empty list excludes operational tools. Restricted agents cannot delegate, switch runtimes, or create autonomous background agent work; those paths would need inherited restrictions before being enabled. Required exact tool names are checked against workspace capabilities at execution. Inspection profiles should exclude shell tools.

Owner-confirmed deletion preserves read-only owner history, removes shared use, clears defaults, and withdraws unstarted agent turns. Active turns may finish with their admitted immutable package. Cleanup is idempotent and retried by the durable deletion recovery sweep. Chats and workspace files, memory, skills, credentials, and sandbox resources are preserved. Archived projects freeze their owned agents; independently owned agents merely shared to that project remain intact.
