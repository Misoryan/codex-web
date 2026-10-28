import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { FastifyInstance } from "fastify";

const compress = promisify(gzip);

// Feature evaluation is a bounded HTTP document, not an IPC message stream.
export async function registerFeatureConfig(app: FastifyInstance, fetchUpstream = globalThis.fetch) {
 await app.register(async scope => {
  // The SDK may encode/compress its request; preserve those bytes and query flags.
  scope.removeContentTypeParser("application/json");
  scope.addContentTypeParser("application/json", {parseAs: "buffer"}, (_request, body, done) => done(null, body));
  const pending = new Map<string, Promise<{ status: number; bytes: Buffer; compressed: Buffer; retryAfter: string | null }>>();
  scope.post("/__backend/feature-config", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff");
    const origin = request.headers.origin;
    let foreign = request.headers["sec-fetch-site"] === "cross-site";
    if (origin) {
      try { foreign ||= new URL(origin).host !== request.headers.host; }
      catch { foreign = true; }
    }
    if (foreign) return reply.code(403).send({ error: "Forbidden" });
    if (!Buffer.isBuffer(request.body) || request.body.length === 0)
      return reply.code(400).send({ error: "Expected evaluation request" });

    const upstream = new URL("https://ab.chatgpt.com/v1/initialize");
    upstream.search = new URL(request.url, "http://localhost").search;
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const [name, value] of Object.entries(request.headers)) {
      if (/^(?:x-)?statsig-/.test(name) && typeof value === "string") headers[name] = value;
    }
    const body = request.body;
    const key = createHash("sha256").update(body).update(JSON.stringify([upstream.href,
      Object.entries(headers).filter(([name]) => !["statsig-client-time", "statsig-retry-count"].includes(name)).sort(),
    ])).digest("hex");
    let operation = pending.get(key);
    if (!operation) {
      operation = (async () => {
        const response = await fetchUpstream(upstream, {
          method: "POST", headers, body: new Uint8Array(body), redirect: "error", signal: AbortSignal.timeout(30_000),
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        return { status: response.status, bytes, compressed: await compress(bytes), retryAfter: response.headers.get("retry-after") };
      })();
      pending.set(key, operation);
      void operation.finally(() => pending.delete(key)).catch(() => {});
    }
    try {
      const result = await operation;
      reply.code(result.status).type("application/json; charset=utf-8");
      if (result.retryAfter) reply.header("Retry-After", result.retryAfter);
      if (result.status === 204 || result.status === 304) return reply.send();
      reply.header("Vary", "Accept-Encoding");
      const gzipAccepted = (request.headers["accept-encoding"] || "").split(",").some(value => {
        const [coding, ...parameters] = value.trim().toLowerCase().split(";");
        const quality = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith("q="));
        return coding === "gzip" && (quality === undefined || Number(quality.slice(2)) > 0);
      });
      if (gzipAccepted) {
        reply.header("Content-Encoding", "gzip");
        return reply.send(result.compressed);
      }
      return reply.send(result.bytes);
    } catch {
      return reply.code(502).send({ error: "Feature configuration unavailable" });
    }
  });
 });
}
