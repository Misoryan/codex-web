import type { UsageConfig } from "./sub2api-usage";

const MINUTE = 60_000;
const time = (value: unknown): number =>
  typeof value === "string" ? Date.parse(value) : NaN;
const future = (value: unknown, now: number) => time(value) > now;

// Subscription percentages, never token counts, prices or billing multipliers.
export function capacityReport(input: any[], groups: number[], now: number) {
  const seen = new Set<number>();
  const accounts = input
    .filter(
      (a) =>
        a.platform === "openai" &&
        a.type === "oauth" &&
        a.group_ids?.some((id: number) => groups.includes(id)),
    )
    .map((a) => {
      if (!Number.isSafeInteger(a.id) || seen.has(a.id))
        throw Error("Invalid account list");
      seen.add(a.id);
      const extra = a.extra || {},
        plan = String(a.credentials?.plan_type || "unknown");
      const used = extra.codex_7d_used_percent,
        sampled = time(extra.codex_usage_updated_at);
      const valid =
        typeof used === "number" &&
        Number.isFinite(used) &&
        used >= 0 &&
        used <= 100 &&
        extra.codex_7d_window_minutes === 10080 &&
        future(extra.codex_7d_reset_at, now) &&
        Number.isFinite(sampled) &&
        sampled <= now + 5 * MINUTE;
      const enabled =
        a.status === "active" &&
        a.schedulable === true &&
        !(Number.isFinite(time(a.expires_at)) && time(a.expires_at) <= now);
      const blocked =
        future(a.rate_limit_reset_at, now) ||
        future(a.overload_until, now) ||
        future(a.temp_unschedulable_until, now);
      return {
        id: a.id,
        plan,
        enabled,
        available: enabled && !blocked,
        remainingPercent: valid ? 100 - used : null,
        resetAt: valid
          ? new Date(time(extra.codex_7d_reset_at)).toISOString()
          : null,
        sampledAt: Number.isFinite(sampled)
          ? new Date(sampled).toISOString()
          : null,
        stale: !valid || now - sampled > 15 * MINUTE,
        subscriptionExpiresAt: Number.isFinite(
          time(a.credentials?.subscription_expires_at),
        )
          ? new Date(time(a.credentials.subscription_expires_at)).toISOString()
          : null,
      };
    });
  const pro = accounts.filter((a) => a.plan === "pro" && a.enabled);
  const known = pro.filter((a) => a.remainingPercent !== null);
  const pending = pro.length - known.length;
  const resets = known
    .filter((a) => a.resetAt)
    .sort((a, b) => time(a.resetAt) - time(b.resetAt));
  const first = resets[0];
  // Bound each group by its first reset, rather than chaining indefinitely.
  const batch = first
    ? resets.filter((a) => time(a.resetAt) - time(first.resetAt) <= 30 * MINUTE)
    : [];
  return {
    basis: "20x-weekly",
    generatedAt: new Date(now).toISOString(),
    proCount: pro.length,
    totalPercent: pro.length * 100,
    remainingPercent: known.length
      ? known.reduce(
          (sum, a) => sum + (a.available ? a.remainingPercent! : 0),
          0,
        )
      : null,
    missingAccounts: pending,
    staleAccounts: pro.filter((a) => a.stale).length,
    nextReset: first
      ? {
          from: first.resetAt,
          to: batch.at(-1)!.resetAt,
          count: batch.length,
          capacityPercent: batch.length * 100,
          refillPercent: batch.reduce(
            (sum, a) => sum + 100 - a.remainingPercent!,
            0,
          ),
          renewalUncertain: batch.filter(
            (a) =>
              a.subscriptionExpiresAt &&
              time(a.subscriptionExpiresAt) <= time(a.resetAt),
          ).length,
        }
      : null,
    accounts,
  };
}

export function createCapacityService(
  config: UsageConfig,
  http: typeof fetch = fetch,
  clock = Date.now,
) {
  let report: ReturnType<typeof capacityReport> | null = null,
    due = 0,
    failures = 0;
  let pending: Promise<void> | undefined;
  let groups: number[] = [],
    groupsUntil = 0;
  async function get(endpoint: string) {
    const response = await http(
      config.baseUrl.replace(/\/$/, "") + "/api/v1/admin" + endpoint,
      {
        headers: { "x-api-key": config.adminKey },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      },
    );
    if (response.status === 429) {
      const raw = response.headers.get("retry-after");
      const delay =
        raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : time(raw) - clock();
      due = Math.max(
        due,
        clock() + Math.min(3_600_000, Math.max(MINUTE, delay || MINUTE)),
      );
    }
    if (!response.ok) throw Error("Capacity unavailable");
    const body = (await response.json()) as { code: number; data: any };
    if (body.code !== 0 || !body.data) throw Error("Invalid capacity response");
    return body.data;
  }
  async function list(endpoint: string) {
    const items: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await get(
        `${endpoint}${endpoint.includes("?") ? "&" : "?"}page=${page}&page_size=100`,
      );
      if (
        !Array.isArray(data.items) ||
        !Number.isSafeInteger(data.total) ||
        data.total < 0
      )
        throw Error("Invalid pagination");
      items.push(...data.items);
      if (items.length === data.total) return items;
      if (!data.items.length || items.length > data.total) break;
    }
    throw Error("Incomplete account list");
  }
  return {
    async read() {
      if (!pending && clock() >= due)
        pending = (async () => {
          try {
            if (clock() >= groupsUntil) {
              const keys = await list(`/users/${config.userId}/api-keys`);
              groups = [
                ...new Set<number>(
                  keys
                    .filter(
                      (k) =>
                        k.status === "active" &&
                        k.group?.platform === "openai" &&
                        !(
                          Number.isFinite(time(k.expires_at)) &&
                          time(k.expires_at) <= clock()
                        ),
                    )
                    .map((k) => k.group_id),
                ),
              ];
              if (groups.some((id) => !Number.isSafeInteger(id) || id <= 0))
                throw Error("Invalid group");
              groupsUntil = clock() + 10 * MINUTE;
            }
            const rows = groups.length
              ? await list("/accounts?platform=openai&type=oauth&lite=true")
              : [];
            report = capacityReport(rows, groups, clock());
            failures = 0;
            due = clock() + MINUTE;
          } catch {
            failures++;
            due = Math.max(
              due,
              clock() +
                Math.min(15 * MINUTE, MINUTE * 2 ** Math.min(failures - 1, 4)),
            );
          }
        })().finally(() => {
          pending = undefined;
        });
      await pending;
      return {
        report,
        stale: failures > 0,
        nextRefreshAt: new Date(due).toISOString(),
      };
    },
  };
}
