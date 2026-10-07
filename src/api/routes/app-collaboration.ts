import { sendJson } from "../http.ts";
import { deploymentView } from "../app-types.ts";
import { GitHubError } from "../../deploy/github-client.ts";
import { errMessage } from "../../util/errors.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

async function collaboration(ctx: ApiCtx) {
  const actor = ctx.capability?.actorId ?? ctx.actor?.p;
  if (!actor) return sendJson(ctx.res, 401, { error: "identity_required" });
  if (!ctx.deps.appGitHub) return sendJson(ctx.res, 503, { error: "not_configured" });
  try {
    const result =
      ctx.method === "GET"
        ? await ctx.deps.appGitHub.inspect(ctx.params.id!, actor)
        : await ctx.deps.appGitHub.execute(ctx.params.id!, actor, ctx.params.action!, isObj(ctx.body) ? ctx.body : {});
    sendJson(ctx.res, 200, result);
  } catch (error) {
    sendJson(ctx.res, error instanceof GitHubError ? error.status : 409, {
      error: "collaboration_failed",
      message: errMessage(error),
    });
  }
}

async function release(ctx: ApiCtx) {
  const actor = ctx.capability?.actorId ?? ctx.actor?.p;
  if (!actor) return sendJson(ctx.res, 401, { error: "identity_required" });
  const store = ctx.deps.deployStore;
  if (!store) return sendJson(ctx.res, 503, { error: "not_configured" });
  const app = await ctx.app.getDeployment(ctx.params.id!);
  if (!app || !(await ctx.app.deploymentGitPermissionFor(app.id, actor)))
    return sendJson(ctx.res, 404, { error: "not_found" });
  const version = Number(ctx.params.version);
  if (!Number.isInteger(version) || !(await store.versionOf(app.id, version)))
    return sendJson(ctx.res, 404, { error: "not_found" });
  if (ctx.method === "PATCH") {
    if (!(await ctx.app.canManageDeployment(app.id, actor))) return sendJson(ctx.res, 403, { error: "forbidden" });
    const body = ctx.body;
    if (
      !isObj(body) ||
      typeof body.title !== "string" ||
      !body.title.trim() ||
      body.title.length > 200 ||
      typeof body.description !== "string" ||
      body.description.length > 10000
    )
      return sendJson(ctx.res, 400, { error: "invalid_release_text" });
    await (ctx.deps.advisoryLock?.withLock(`deploy:${app.id}`, () =>
      store.editRelease(app.id, version, { title: body.title as string, description: body.description as string }),
    ) ?? store.editRelease(app.id, version, { title: body.title, description: body.description }));
    return sendJson(ctx.res, 200, { deployment: deploymentView((await store.get(app.id))!) });
  }
  const fromParam = ctx.url.searchParams.get("from");
  const from =
    fromParam === null
      ? app.versions.find((v) => v.commit === app.versions.find((v) => v.version === version)?.parentCommit)?.version
      : Number(fromParam);
  if (from !== undefined && (!Number.isInteger(from) || !(await store.versionOf(app.id, from))))
    return sendJson(ctx.res, 400, { error: "invalid_comparison_version" });
  const diff = await store.diffVersions(app.id, from, version);
  const before = from === undefined ? [] : await store.filesOf(app.id, from);
  const after = await store.filesOf(app.id, version);
  const text = (data: string | Uint8Array | undefined) => {
    if (data === undefined) return null;
    const bytes = Buffer.from(data);
    return bytes.includes(0) || bytes.length > 500_000 ? "Binary or large file" : bytes.toString("utf8");
  };
  const changes = diff
    ? [...diff.added, ...diff.modified, ...diff.deleted].map((f) => ({
        path: f.path,
        before: text(before?.find((b) => b.path === f.path)?.data),
        after: text(after?.find((a) => a.path === f.path)?.data),
      }))
    : [];
  sendJson(ctx.res, 200, {
    release: deploymentView(app).versions.find((v) => v.version === version),
    fromVersion: from,
    diff,
    changes,
    events: (app.events ?? []).filter((e) => e.toVersion === version),
  });
}

export const appCollaborationRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/deployments/:id/collaboration", auth: "either", handle: collaboration },
  { method: "POST", path: "/v1/deployments/:id/collaboration/:action", auth: "either", handle: collaboration },
  { method: "GET", path: "/v1/deployments/:id/versions/:version", auth: "either", handle: release },
  { method: "PATCH", path: "/v1/deployments/:id/versions/:version", auth: "either", handle: release },
];
