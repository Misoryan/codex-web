import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// The public gateway serves this path from its authenticated website. Direct
// loopback clients use the explicitly configured identity of this installation.
export async function registerLocalProfile(app: FastifyInstance) {
  const file = path.resolve("runtime/private/local-profile.json");
  app.get("/maa/api/auth/me", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const address = request.raw.socket.remoteAddress;
    const host = request.headers.host;
    const origin = request.headers.origin;
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address || "") ||
      !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host || "") ||
      Object.keys(request.headers).some(key => key === "forwarded" || key.startsWith("x-forwarded-")) ||
      request.headers["sec-fetch-site"] === "cross-site" ||
      (origin !== undefined && origin !== `http://${host}`)
    ) return reply.code(403).send({ error: "Local profile requires direct loopback access" });

    try {
      const config = JSON.parse(await fs.readFile(file, "utf8"));
      if (typeof config.github !== "string" || !/^[a-zA-Z0-9-]{1,39}$/.test(config.github)) {
        return reply.code(503).send({ error: "Invalid local profile configuration" });
      }
      return { user: { github: config.github } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { user: null };
      return reply.code(503).send({ error: "Invalid local profile configuration" });
    }
  });
}
