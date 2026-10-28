import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

function foreignRequest(request: FastifyRequest) {
  if (request.headers["sec-fetch-site"] === "cross-site") return true;
  try { return !!request.headers.origin && new URL(request.headers.origin).host !== request.headers.host; }
  catch { return true; }
}

// HTTP documents give embedded apps normal URL/history semantics. The sandbox
// header keeps their origin opaque, including when a document is opened alone.
export async function registerMcpAppDocuments(app: FastifyInstance) {
  const documents = new Map<string, { html: string; expires: number }>();
  const prefix = "/__backend/mcp-app-documents";
  app.addHook("onClose", async () => { documents.clear(); });
  app.post(prefix, {
    bodyLimit: 16 * 1024 * 1024,
    schema: { body: { type: "object", additionalProperties: false, required: ["html"], properties: { html: { type: "string", minLength: 1 } } } },
  }, async (request, reply) => {
    if (foreignRequest(request))
      return reply.code(403).send({ error: "Forbidden" });
    const now = Date.now();
    for (const [id, document] of documents) if (document.expires <= now) documents.delete(id);
    const html = (request.body as { html: string }).html;
    const size = [...documents.values()].reduce((total, document) => total + Buffer.byteLength(document.html), Buffer.byteLength(html));
    if (size > 32 * 1024 * 1024) return reply.code(503).send({ error: "App document capacity reached" });
    const id = randomUUID();
    documents.set(id, { html, expires: now + 15 * 60_000 });
    return reply.header("Cache-Control", "no-store").send({ url: prefix + "/" + id });
  });
  app.get(prefix + "/:id", async (request, reply) => {
    const document = documents.get((request.params as { id: string }).id);
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
    if (!document || document.expires <= Date.now()) return reply.code(404).send({ error: "Document unavailable" });
    return reply.header("Content-Security-Policy", "sandbox allow-scripts allow-forms; frame-ancestors 'self'").type("text/html; charset=utf-8").send(document.html);
  });
  app.delete(prefix + "/:id", async (request, reply) => {
    if (foreignRequest(request))
      return reply.code(403).send({ error: "Forbidden" });
    documents.delete((request.params as { id: string }).id);
    return reply.code(204).send();
  });
}
