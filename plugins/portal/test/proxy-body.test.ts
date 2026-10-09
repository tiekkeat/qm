import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { proxyToSurface, proxyToDeployment, proxyToUpstream } from "../src/proxy.ts";

const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString(), headers: req.headers }));
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
const portal = createServer((req, res) => {
  if (req.url === "/deployment")
    return proxyToDeployment(req, res, {
      coreBase: upstreamBase,
      id: "app",
      subPath: "/",
      search: "",
      principal: "owner",
      signingSecret: "test-secret",
    });
  if (req.url === "/upstream")
    return proxyToUpstream(req, res, { baseUrl: upstreamBase, path: "/", search: "" }, ["content-type"]);
  proxyToSurface(req, res, {
    upstreamBase,
    forwardPath: "/api/projects/project",
    search: "",
    cookieName: "webuiuser",
    principal: "owner",
  });
});
await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
test.after(() => {
  portal.close();
  upstream.close();
});

for (const path of ["/surface", "/deployment", "/upstream"]) {
  for (const framing of ["content-length", "transfer-encoding"]) {
    test(`DELETE JSON body survives ${path} proxy with ${framing}`, async () => {
      const body = JSON.stringify({ confirm: true });
      const result = await new Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }>(
        (resolve, reject) => {
          const outgoing = request(
            `${base}${path}`,
            {
              method: "DELETE",
              headers: {
                "content-type": "application/json",
                [framing]: framing === "content-length" ? String(Buffer.byteLength(body)) : "chunked",
              },
            },
            (res) => {
              let raw = "";
              res.setEncoding("utf8");
              res.on("data", (chunk) => {
                raw += chunk;
              });
              res.on("end", () => resolve({ status: res.statusCode!, ...JSON.parse(raw) }));
              res.on("error", reject);
            },
          );
          outgoing.on("error", reject);
          outgoing.end(body);
        },
      );
      assert.equal(result.status, 200);
      assert.equal(result.body, body);
      assert.equal(result.headers[framing], framing === "content-length" ? String(Buffer.byteLength(body)) : "chunked");
    });
  }
}
