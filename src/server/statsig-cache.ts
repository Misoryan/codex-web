import { fingerprint, isStatsigPublication, type StatsigCacheHint } from "../shared/statsig-wire";

type Snapshot = Readonly<{ hash: string; serialized: string }>;
const MAX_BYTES = 16 * 1024 * 1024;

// Only the latest full publication is retained globally. A connection pins its
// advertised snapshot until close, so another tab/account cannot invalidate it.
// Snapshots share immutable strings; references are never read from disk.
export class StatsigCache {
  private latest: Snapshot | null = null;

  connect() {
    let snapshot = this.latest;
    const hint: StatsigCacheHint = { type: "statsig-cache-hint", hash: snapshot?.hash ?? null };
    return {
      hint,
      expand: (message: unknown): unknown => {
        if (!isStatsigPublication(message)) return message;
        const command = message.args[0];
        if (Object.hasOwn(command, "statsigReference")) {
          if (!snapshot || command.statsigReference !== snapshot.hash || Object.hasOwn(command, "value")) {
            throw new Error("Invalid Statsig cache reference; reload the page");
          }
          const { statsigReference: _reference, ...rest } = command;
          // Parse a fresh object: native consumers cannot mutate the cache.
          return { ...message, args: [{ ...rest, value: JSON.parse(snapshot.serialized) }, ...message.args.slice(1)] };
        }
        const value = command.value;
        if (value && typeof value === "object") {
          const serialized = JSON.stringify(value);
          const bytes = Buffer.byteLength(serialized);
          if (bytes >= 4096 && bytes <= MAX_BYTES) {
            this.latest = Object.freeze({ hash: fingerprint(serialized), serialized });
          }
        }
        return message;
      },
      close: () => { snapshot = null; },
    };
  }
}
