import { createConcurrencyService } from "./sub2api-concurrency";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createCapacityService } from "./sub2api-capacity";

type Range = "today" | "week" | "month";
export type UsageConfig = { baseUrl: string; adminKey: string; userId: number };
type Row = {
  userId: number;
  name: string;
  tokens: number;
  requests: number;
  rank: number;
  share: number;
};
type Report = {
  shareBasis: "actual_cost";
  range: Range;
  startDate: string;
  endDate: string;
  generatedAt: string;
  totalTokens: number;
  totalRequests: number;
  activeUsers: number;
  self: Row & { actualCost: number };
  ranking: Row[];
};
type Entry = {
  report?: Report;
  expires: number;
  retryAt: number;
  failures: number;
  pending?: Promise<void>;
};
const TTL = { today: 60_000, week: 300_000, month: 900_000 };
const DAY = 86_400_000;

export function usageWindow(range: Range, now: number) {
  const local = new Date(now + 8 * 3_600_000);
  const endDate = local.toISOString().slice(0, 10);
  if (range === "week")
    local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  if (range === "month") local.setUTCDate(1);
  return { startDate: local.toISOString().slice(0, 10), endDate };
}

export function createUsageService(
  config: UsageConfig,
  http: typeof fetch = fetch,
  clock = Date.now,
) {
  if (
    !Number.isSafeInteger(config.userId) ||
    config.userId <= 0 ||
    !config.adminKey ||
    new URL(config.baseUrl).protocol !== "https:"
  )
    throw new Error("Invalid Sub2API configuration");
  const cache = new Map<Range, Entry>();
  let names = new Map<number, string>(),
    namesUntil = 0,
    namesRetryAt = 0;
  let namesPending: Promise<void> | undefined;
  let upstreamRetryAt = 0;
  async function get(endpoint: string, params: Record<string, string>) {
    const url = new URL(
      `${config.baseUrl.replace(/\/$/, "")}/api/v1/admin${endpoint}`,
    );
    url.search = new URLSearchParams(params).toString();
    const response = await http(url, {
      headers: { "x-api-key": config.adminKey },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (response.status === 429) {
      const raw = response.headers.get("retry-after");
      const seconds =
        raw && /^\d+$/.test(raw)
          ? Number(raw)
          : Math.max(0, ((raw ? Date.parse(raw) : 0) - clock()) / 1000);
      upstreamRetryAt =
        clock() + Math.max(60_000, Math.min(3_600_000, (seconds || 60) * 1000));
    }
    if (!response.ok) throw new Error("Upstream unavailable");
    const body = (await response.json()) as { code: number; data: any };
    if (body.code !== 0 || !body.data)
      throw new Error("Invalid upstream response");
    return body.data;
  }
  async function loadNames() {
    if (clock() < namesUntil || clock() < namesRetryAt) return;
    if (namesPending) return namesPending;
    namesPending = (async () => {
      try {
        const data = await get("/users", { page: "1", page_size: "1000" });
        if (!Array.isArray(data.items)) throw new Error("Invalid names");
        names = new Map(
          data.items.map((u: any) => [
            Number(u.id),
            String(u.username || `用户 ${u.id}`).slice(0, 80),
          ]),
        );
        namesUntil = clock() + DAY;
      } catch {
        namesRetryAt = clock() + 300_000;
      }
    })().finally(() => {
      namesPending = undefined;
    });
    return namesPending;
  }
  function number(value: unknown) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new Error("Invalid usage metrics");
    return value;
  }
  return {
    async read(range: Range) {
      const window = usageWindow(range, clock());
      let entry = cache.get(range);
      if (!entry) {
        entry = { expires: 0, retryAt: 0, failures: 0 };
        cache.set(range, entry);
      }
      const current = entry;
      if (
        !current.pending &&
        clock() >= Math.max(current.retryAt, upstreamRetryAt) &&
        (!current.report ||
          current.report.endDate !== window.endDate ||
          clock() >= current.expires)
      ) {
        current.pending = (async () => {
          try {
            const data = await get("/dashboard/user-breakdown", {
              start_date: window.startDate,
              end_date: window.endDate,
              timezone: "Asia/Shanghai",
              limit: "200",
              sort_by: "actual_cost",
            });
            if (!Array.isArray(data.users) || data.users.length >= 200)
              throw new Error("Incomplete usage");
            const seen = new Set<number>();
            const costs = new Map<number, number>();
            const rows: Row[] = data.users.map((u: any) => {
              const id = number(u.user_id);
              if (!Number.isSafeInteger(id) || seen.has(id))
                throw new Error("Invalid user ID");
              seen.add(id);
              costs.set(id, number(u.actual_cost));
              return {
                userId: id,
                name: "",
                tokens: number(u.input_tokens) + number(u.output_tokens),
                requests: number(u.requests),
                rank: 0,
                share: 0,
              };
            });
            await loadNames();
            const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
            const totalCost = [...costs.values()].reduce(
              (sum, cost) => sum + cost,
              0,
            );
            if (!Number.isFinite(totalCost))
              throw new Error("Invalid total cost");
            rows.sort(
              (a, b) =>
                costs.get(b.userId)! - costs.get(a.userId)! ||
                a.userId - b.userId,
            );
            rows.forEach((row, i) => {
              row.name = names.get(row.userId) || `用户 ${row.userId}`;
              row.rank = i + 1;
              row.share = totalCost
                ? (costs.get(row.userId)! / totalCost) * 100
                : 0;
            });
            const self = rows.find((row) => row.userId === config.userId) || {
              userId: config.userId,
              name: names.get(config.userId) || "我",
              tokens: 0,
              requests: 0,
              rank: 0,
              share: 0,
            };
            current.report = {
              shareBasis: "actual_cost",
              range,
              ...window,
              generatedAt: new Date(clock()).toISOString(),
              totalTokens,
              totalRequests: rows.reduce((sum, row) => sum + row.requests, 0),
              activeUsers: rows.length,
              self: { ...self, actualCost: costs.get(config.userId) ?? 0 },
              ranking: rows.slice(0, 10),
            };
            current.expires = clock() + TTL[range];
            current.failures = 0;
            current.retryAt = 0;
          } catch {
            current.failures += 1;
            current.retryAt =
              clock() +
              Math.min(
                900_000,
                60_000 * 2 ** Math.min(current.failures - 1, 4),
              );
          }
        })().finally(() => {
          current.pending = undefined;
        });
      }
      await current.pending;
      const stale =
        !current.report ||
        current.failures > 0 ||
        current.report.endDate !== window.endDate ||
        clock() >= current.expires;
      return {
        enabled: true,
        report: current.report || null,
        stale,
        error: stale ? "更新暂不可用，稍后自动重试" : null,
        nextRefreshAt: new Date(
          Math.max(current.expires, current.retryAt, upstreamRetryAt),
        ).toISOString(),
      };
    },
  };
}

export async function registerSub2ApiUsage(app: FastifyInstance) {
  let service: ReturnType<typeof createUsageService> | undefined;
  let capacity: ReturnType<typeof createCapacityService> | undefined;
  let concurrency: ReturnType<typeof createConcurrencyService> | undefined;
  let invalid = false;
  try {
    const file = path.resolve("runtime/private/sub2api-usage.json");
    const config = JSON.parse(await fs.readFile(file, "utf8"));
    service = createUsageService(config);
    capacity = createCapacityService(config);
    concurrency = createConcurrencyService(config);
  } catch (error) {
    invalid = (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  app.get("/__backend/sub2api/usage", async (request, reply) => {
    reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff");
    // Same trusted-LAN/public-login boundary as this Web instance. No cross-site browser reads.
    const origin = request.headers.origin;
    let foreignOrigin = false;
    if (origin) {
      try {
        foreignOrigin = new URL(origin).host !== request.headers.host;
      } catch {
        foreignOrigin = true;
      }
    }
    if (request.headers["sec-fetch-site"] === "cross-site" || foreignOrigin)
      return reply.code(403).send({ error: "Forbidden" });
    const range = (request.query as { range?: string }).range || "today";
    if (!["today", "week", "month"].includes(range))
      return reply.code(400).send({ error: "Invalid range" });
    if (!service)
      return reply.code(invalid ? 503 : 200).send({
        enabled: invalid,
        report: null,
        stale: invalid,
        error: invalid ? "用量统计配置无效" : null,
      });
    const [usage, remaining, activity] = await Promise.all([
      service.read(range as Range),
      capacity!.read(),
      concurrency!.read(),
    ]);
    return { ...usage, capacity: remaining, activity };
  });
}
