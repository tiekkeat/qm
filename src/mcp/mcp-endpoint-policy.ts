import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import { Agent, fetch as outboundFetch } from "undici";
import type { DurableMap } from "../persistence/durable-map.ts";

export interface McpEndpointPolicy {
  allowInsecurePrivateEndpoints: boolean;
}

export class McpEndpointPolicyError extends Error {}

const privateAddresses = new BlockList();
const privateV6Addresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["168.63.129.16", 32],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  privateAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  privateV6Addresses.addSubnet(address, prefix, "ipv6");

export function isPublicMcpAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !privateAddresses.check(address, "ipv4")
    : family === 6 && /^[23]/.test(address) && !privateV6Addresses.check(address, "ipv6");
}

export function validateMcpPolicy(input: unknown): McpEndpointPolicy {
  const value = input as McpEndpointPolicy;
  if (!value || typeof value.allowInsecurePrivateEndpoints !== "boolean")
    throw new Error("allowInsecurePrivateEndpoints must be a boolean");
  return { allowInsecurePrivateEndpoints: value.allowInsecurePrivateEndpoints };
}

export function createMcpEndpointPolicy(
  store: DurableMap<McpEndpointPolicy>,
  resolve: (hostname: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>> = lookup,
) {
  const read = async (): Promise<McpEndpointPolicy> => {
    const policy = await store.get("policy");
    return { allowInsecurePrivateEndpoints: policy?.allowInsecurePrivateEndpoints ?? true };
  };
  async function validate(
    input: string | URL,
  ): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("MCP endpoints must use HTTP or HTTPS");
    if (url.username || url.password || url.hash) throw new Error("MCP URLs must not contain credentials or fragments");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const { allowInsecurePrivateEndpoints } = await read();
    if (url.protocol !== "https:" && !allowInsecurePrivateEndpoints)
      throw new McpEndpointPolicyError(
        "HTTP MCP endpoints are disabled; ask an admin to enable Allow HTTP and private MCP endpoints",
      );
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await resolve(hostname, { all: true });
    if (!addresses.length) throw new Error("MCP endpoint did not resolve to any IP addresses");
    if (!allowInsecurePrivateEndpoints && addresses.some(({ address }) => !isPublicMcpAddress(address)))
      throw new McpEndpointPolicyError(
        "Private MCP endpoints are disabled; ask an admin to enable Allow HTTP and private MCP endpoints",
      );
    return { url, addresses };
  }
  const guardedFetch: typeof fetch = async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    const { url, addresses } = await validate(target);
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          const selected =
            addresses.find((entry) => !options.family || entry.family === options.family) ?? addresses[0]!;
          if (options.all) callback(null, addresses);
          else callback(null, selected.address, selected.family);
        },
      },
    });
    try {
      const response = await outboundFetch(url, {
        ...(init as Parameters<typeof outboundFetch>[1]),
        redirect: "error",
        dispatcher,
        signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(init?.signal ? [init.signal] : [])]),
      });
      if (response.status >= 300 && response.status < 400) throw new Error("MCP endpoint redirects are not allowed");
      const reader = response.body?.getReader();
      let size = 0;
      const cleanup = async () => {
        await dispatcher.close();
      };
      const body = reader
        ? new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const part = await reader.read();
                if (part.done) {
                  controller.close();
                  await cleanup();
                  return;
                }
                size += part.value.length;
                if (size > 2_000_000) throw new Error("MCP response exceeded 2 MB");
                controller.enqueue(part.value);
              } catch (error) {
                controller.error(error);
                await reader.cancel().catch(() => {});
                await cleanup();
              }
            },
            async cancel(reason) {
              await reader.cancel(reason);
              await cleanup();
            },
          })
        : null;
      if (!body) await cleanup();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
      });
    } catch (error) {
      await dispatcher.destroy();
      throw error;
    }
  };
  return {
    read,
    validate,
    fetch: guardedFetch,
    async write(input: unknown) {
      const policy = validateMcpPolicy(input);
      await store.put("policy", policy);
      return policy;
    },
  };
}

export type McpNetworkPolicy = ReturnType<typeof createMcpEndpointPolicy>;
