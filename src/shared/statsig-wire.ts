import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { configure } from "safe-stable-stringify";

const stableStringify = configure({ deterministic: true, circularValue: Error, bigint: false });

export type StatsigCacheHint = { type: "statsig-cache-hint"; hash: string | null };
export type StatsigEnvelope = {
  type: "ipc-renderer-send" | "ipc-renderer-invoke";
  channel: string;
  args: [Record<string, unknown>, ...unknown[]];
  [key: string]: unknown;
};

export function isStatsigPublication(message: unknown): message is StatsigEnvelope {
  if (!message || typeof message !== "object") return false;
  const m = message as StatsigEnvelope;
  return (m.type === "ipc-renderer-send" || m.type === "ipc-renderer-invoke") &&
    m.channel === "codex_desktop:message-from-view" && Array.isArray(m.args) &&
    m.args[0]?.type === "shared-object-set" && m.args[0]?.key === "statsig_evaluations";
}

export function fingerprint(serialized: string): string {
  const publication = JSON.parse(serialized);
  // The SDK reorders object properties between loads without changing values.
  // Normalize JSON key order, including the JSON string inside `payload`.
  // Arrays, identity, unknown fields and every configuration value remain part
  // of the fingerprint. Native consumers parse this payload as JSON.
  if (typeof publication.payload === "string") {
    publication.payload = stableStringify(JSON.parse(publication.payload));
  }
  return bytesToHex(sha256(new TextEncoder().encode(stableStringify(publication))));
}

// Synchronous transformation at the existing send point. No promise, gate,
// retry, or second queue: subsequent messages retain their original ordering.
export function referenceStatsig(message: unknown, hash: string | null): unknown {
  if (!hash || !isStatsigPublication(message)) return message;
  const value = message.args[0].value;
  if (!value || typeof value !== "object") return message;
  if (fingerprint(JSON.stringify(value)) !== hash) return message;
  const { value: _value, ...command } = message.args[0];
  return { ...message, args: [{ ...command, statsigReference: hash }, ...message.args.slice(1)] };
}
