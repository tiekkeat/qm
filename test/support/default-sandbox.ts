import type { BuiltApp } from "../../src/wiring.ts";
import type { ScopeId } from "../../src/types.ts";

export async function selectDefaultSandbox(built: BuiltApp, _actorId: string, ...scopes: ScopeId[]): Promise<void> {
  for (const scopeId of scopes) {
    const resources = built.sandboxResources;
    const managerId = "admin-alice";
    const record = await resources.create(managerId, scopeId, resources.defaultBackend());
    await resources.setDefault(managerId, scopeId, record.id);
  }
}
