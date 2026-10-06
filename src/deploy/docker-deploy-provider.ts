import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec, type DockerExec } from "../sandbox/docker-exec.ts";
import { errMessage } from "../util/errors.ts";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSecrets } from "../harness/redact-secrets.ts";

const APP_PORT = 8080;
const LEGACY_NETWORK = "agent-deploynet";
const DAEMON_PROBE_TIMEOUT_MS = 10_000;
const APP_READY_TIMEOUT_MS = 30_000;

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  basePort?: number;
  dockerExec?: DockerExec;
  coreContainer?: string;
  fetchImpl?: typeof fetch;
}

export interface DockerDaemonProbeOptions {
  docker?: string;
  dockerExec?: DockerExec;
}

export async function dockerDaemonFailure(opts: DockerDaemonProbeOptions = {}): Promise<string | null> {
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.docker ?? "docker");
  try {
    const r = await dexec(["version", "-f", "{{.Server.Version}}"], DAEMON_PROBE_TIMEOUT_MS);
    if (r.code === 0) return null;
    const stderr = r.stderr.trim();
    if (stderr) return stderr;
    return r.code < 0 ? `no response within ${DAEMON_PROBE_TIMEOUT_MS / 1000}s` : `exit ${r.code}`;
  } catch (e) {
    return errMessage(e);
  }
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";
  let nextPort = opts.basePort ?? 9200;
  const ports = new Map<string, number>();
  const freed: number[] = [];
  const allocPort = (n: string): number => {
    const existing = ports.get(n);
    if (existing !== undefined) return existing;
    const port = freed.pop() ?? nextPort++;
    ports.set(n, port);
    return port;
  };
  const freePort = (n: string): void => {
    const p = ports.get(n);
    if (p !== undefined) {
      freed.push(p);
      ports.delete(n);
    }
  };

  const dexec = opts.dockerExec ?? spawnDockerExec(docker);
  const fetchImpl = opts.fetchImpl ?? fetch;

  const name = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;
  const network = (d: Deployment) => `${name(d)}-net`;
  const dataVolume = (d: Deployment) => `${name(d)}-data`;
  const endpoint = (d: Deployment, hostPort: number): DeployEndpoint =>
    opts.coreContainer ? { host: name(d), port: APP_PORT } : { host: "127.0.0.1", port: hostPort };
  const connectCore = async (net: string): Promise<void> => {
    if (!opts.coreContainer) return;
    const r = await dexec(["network", "connect", net, opts.coreContainer]);
    if (r.code !== 0 && !/already (?:exists|connected)/i.test(r.stderr))
      throw new Error(`docker network connect ${net} ${opts.coreContainer} failed: ${r.stderr.trim()}`);
  };
  const snapshotOnDockerHost = async (snapshotDir: string): Promise<string> => {
    if (!opts.coreContainer) return snapshotDir;
    const r = await dexec(["inspect", "--format", "{{json .Mounts}}", opts.coreContainer]);
    if (r.code !== 0) throw new Error(`cannot inspect core container mounts: ${r.stderr.trim()}`);
    let mounts: Array<{ Source?: string; Destination?: string }>;
    try {
      mounts = JSON.parse(r.stdout) as Array<{ Source?: string; Destination?: string }>;
      if (!Array.isArray(mounts)) throw new Error("invalid mounts");
    } catch {
      throw new Error("Docker returned invalid core container mounts");
    }
    const snapshot = resolve(snapshotDir);
    const mount = mounts
      .filter((candidate) =>
        candidate.Source && candidate.Destination && isAbsolute(candidate.Source) &&
        (snapshot === candidate.Destination || snapshot.startsWith(`${candidate.Destination}${sep}`)),
      )
      .sort((a, b) => b.Destination!.length - a.Destination!.length)[0];
    if (!mount) throw new Error(`deployment snapshot ${snapshotDir} is outside the core container's Docker mounts`);
    return join(mount.Source!, relative(mount.Destination!, snapshot));
  };
  const running = async (container: string): Promise<boolean> => {
    const r = await dexec(["inspect", "--format", "{{.State.Running}}", container]);
    if (r.code !== 0) {
      if (/no such (?:object|container)|not found/i.test(r.stderr)) return false;
      throw new Error(`docker inspect ${container} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout.trim() === "true";
  };
  const waitReady = async (container: string, address: DeployEndpoint): Promise<void> => {
    const deadline = Date.now() + APP_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await running(container))) {
        const logs = await dexec(["logs", "--tail", "30", container]);
        throw new Error(`deployment ${container} exited during startup: ${redactSecrets(`${logs.stdout}${logs.stderr}`.trim())}`);
      }
      try {
        const response = await fetchImpl(`http://${address.host}:${address.port}/`, { signal: AbortSignal.timeout(2_000) });
        await response.body?.cancel();
        return;
      } catch {
        await new Promise((done) => setTimeout(done, 500));
      }
    }
    throw new Error(`deployment ${container} did not listen on port ${APP_PORT} within ${APP_READY_TIMEOUT_MS / 1000}s`);
  };
  const ensureNetwork = async (net: string): Promise<string> => {
    if ((await dexec(["network", "inspect", net])).code !== 0) {
      const r = await dexec(["network", "create", net]);
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
        throw new Error(`docker network create ${net} failed: ${r.stderr.trim()}`);
      }
    }
    return net;
  };

  const migrateContainer = async (container: string): Promise<boolean> => {
    if (!(await running(container))) return false;
    const inspected = await dexec(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container]);
    if (inspected.code !== 0) {
      if (/no such (?:object|container)|not found/i.test(inspected.stderr)) return false;
      throw new Error(`docker inspect ${container} failed: ${inspected.stderr.trim()}`);
    }
    let attached: Record<string, unknown>;
    try {
      attached = JSON.parse(inspected.stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`docker inspect ${container} returned invalid network state`);
    }
    const target = `${container}-net`;
    await ensureNetwork(target);
    if (!(target in attached)) {
      const connected = await dexec(["network", "connect", target, container]);
      if (connected.code !== 0) throw new Error(`docker network connect ${target} failed: ${connected.stderr.trim()}`);
    }
    if (LEGACY_NETWORK in attached) {
      const disconnected = await dexec(["network", "disconnect", LEGACY_NETWORK, container]);
      if (disconnected.code !== 0)
        throw new Error(`docker network disconnect ${LEGACY_NETWORK} failed: ${disconnected.stderr.trim()}`);
    }
    await connectCore(target);
    return true;
  };
  const migrateTarget = async (container: string): Promise<boolean> => {
    try {
      return await migrateContainer(container);
    } catch {
      return migrateContainer(container);
    }
  };

  return {
    profile: { managedScaleToZero: false, dataDir: "/data" },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      const net = await ensureNetwork(network(d));
      const snapshotDir = await snapshotOnDockerHost(version.snapshotDir);
      await dexec(["rm", "-f", name(d)]);
      const hostPort = opts.coreContainer ? 0 : allocPort(name(d));
      const address = endpoint(d, hostPort);
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const r = await dexec([
        "run",
        "-d",
        "--name",
        name(d),
        "--network",
        net,
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        ...(!opts.coreContainer ? ["-p", `127.0.0.1:${hostPort}:${APP_PORT}`] : []),
        "-v",
        `${snapshotDir}:/app:ro`,
        "-v",
        `${dataVolume(d)}:/data`,
        "-w",
        "/app",
        ...envArgs,
        "-e",
        `PORT=${APP_PORT}`,
        "-e",
        "DATA_DIR=/data",
        image,
        "sh",
        "-c",
        version.entrypoint,
      ]);
      if (r.code !== 0) {
        await dexec(["rm", "-f", name(d)]);
        await dexec(["network", "rm", net]);
        freePort(name(d));
        throw new Error(`deploy run failed: ${r.stderr.trim()}`);
      }
      await connectCore(net);
      await waitReady(name(d), address);
      return address;
    },

    async logs(d: Deployment, opts: { tailLines: number }): Promise<string | null> {
      const lines = Math.max(1, Math.min(2000, Math.floor(opts.tailLines)));
      const r = await dexec(["logs", "--tail", String(lines), name(d)]);
      if (r.code !== 0) return null;
      return `${r.stdout}${r.stderr}`;
    },

    async destroy(d: Deployment): Promise<void> {
      await dexec(["rm", "-f", name(d)]);
      if (opts.coreContainer) await dexec(["network", "disconnect", network(d), opts.coreContainer]);
      await dexec(["network", "rm", network(d)]);
      freePort(name(d));
    },

    async resolveEndpoint(d): Promise<DeployEndpoint | null> {
      return (await migrateTarget(name(d))) ? endpoint(d, d.endpoint?.port ?? 0) : null;
    },
  };
}
