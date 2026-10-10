---
name: agent-management
description: Create, improve, test, publish, share, or delete custom QM agents. Use for normal requests to create a specialist or /agent create, edit, publish, share, delete, or restore.
---

Custom agents are versioned instruction packages, not separate models or sandboxes. Manage them with the native `agents` tool. They appear in Browse → Agents. Workspace permissions, files, memory, credentials, and sandbox ownership remain authoritative.

Use `list` to discover IDs, owners and access. Use `read` with `{id}` to inspect the current editable version or published package. Never pretend to have changed an agent without a successful tool response.

For creation, understand the specialty, intended tasks, constraints, desired outputs, references and tool requirements from the user's request. Prepare a concrete package with name, description, instructions, files, examples, allowedTools (null for workspace permissions), requiredTools (exact MCP/native tool names). Call `create` with `{package}` in the current personal/project workspace. The result is a draft v1. Explain that publishing is explicit.

For edits, read the latest package, propose the concrete change, then save after the user accepts it. A direct user instruction specifying the change authorizes that change; ask only if acceptance or an important requirement is missing. Call `save` with `{id, package, expectedVersion, summary}`. Every changed save creates an immutable revision; no-op saves do not bump the version. On a conflict reload, explain and reconcile. Never publish automatically.

Use `publish` with `{id,version}` only when requested. Publishing points to an existing saved version. Existing conversations stay pinned until the user updates them. Users select agents through the composer dropdown or `/agent slug task`; `/agent default` returns to QM. Use the Browse test button to test a saved draft as a Contributor. Tests are real chats and use that chat's workspace and permissions.

Files use relative safe paths under skills/, references/, scripts/, templates/, or examples/. AGENT.md is generated from instructions. Copy authorized skill snapshots via Browse Import skill snapshot; do not make a recipient depend on access to the original skill. Read selected package files with `agent_package`. Package sharing includes these files, never workspace secrets or operational memory.

Use exact native tool names or action restrictions such as files.read and skills.read. An empty allowedTools list allows no operational tools. Inspection profiles must exclude shell execution. Restricted profiles cannot delegate, switch runtimes, or create autonomous background agent work. requiredTools detects missing connections; it does not grant access.

Owner controls sharing and deletion; Contributors may edit and publish; User recipients may read and run published versions and suggest improvements. Use `share` with `{id,scopeId,role:"user"|"contributor"|null}`. Recipient scope is personal:<email> or group:web-project-<id>. Role null removes access. Use `suggest` with `{id,text}` for improvement proposals without edit permission. Use `restore` with `{id,version,expectedVersion}` to create a revision from a prior package.

Before deletion describe the specific agent and effects and obtain explicit confirmation. An explicit confirmed deletion request is sufficient. Call `delete` with `{id,confirm:true}`. The owner retains read-only history; shared selection and new execution stop; defaults are cleared. Existing chats, files, memory, skills, credentials, and sandbox are preserved. Project retirement freezes project-owned agents as retained history.
