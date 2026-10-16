import { randomUUID } from "node:crypto";
type Transport = { send: (frame: unknown) => void; close: () => void };
type Entry<W> = {
  document: string;
  epoch: string;
  window: Promise<W>;
  owner: object;
  transport?: Transport;
  timer?: ReturnType<typeof setTimeout>;
  detachedAt?: number;
  events: Map<number, string>;
  bytes: number;
  head: number;
  ack: number;
  clientAck: number;
};
// Native IPC belongs to a document, not a disposable WebSocket.
export class RendererSessions<W> {
  private sessions = new Map<string, Entry<W>>();
  private bytes = 0;
  constructor(
    private create: () => Promise<W>,
    private destroy: (window: W) => void,
    private limits = {
      graceMs: 2 * 60 * 60_000,
      sessionBytes: 32 * 1024 * 1024,
      totalBytes: 256 * 1024 * 1024,
      sessions: 64,
    },
    private observe?: (event: string, id: string, document: string, fields: Record<string, string | number | boolean>) => void,
  ) {}
  private discard(id: string, entry: Entry<W>, reason: string) {
    if (this.sessions.get(id) !== entry) return;
    this.observe?.("discard", id, entry.document, { reason, bufferedBytes: entry.bytes, pendingEvents: entry.events.size });
    this.sessions.delete(id);
    clearTimeout(entry.timer);
    this.bytes -= entry.bytes;
    entry.events.clear();
    entry.bytes = 0;
    entry.transport?.send({ type: "renderer-reset", reason });
    entry.transport?.close();
    entry.transport = undefined;
    void entry.window.then(this.destroy).catch(() => {});
  }
  private evictDetached(): boolean {
    let oldest: [string, Entry<W>] | undefined;
    for (const pair of this.sessions) {
      const entry = pair[1];
      if (entry.transport || entry.detachedAt === undefined) continue;
      if (!oldest || entry.detachedAt < oldest[1].detachedAt!) oldest = pair;
    }
    if (!oldest) return false;
    this.discard(oldest[0], oldest[1], "离线页面的恢复缓存已回收");
    return true;
  }
  attach(
    id: string,
    document: string,
    epoch: string | null,
    ack: number,
    owner: object,
    transport: Transport,
  ) {
    let entry = this.sessions.get(id);
    if (
      epoch &&
      (!entry || entry.epoch !== epoch || entry.document !== document)
    )
      throw Error("会话已过期或服务已重启");
    if (entry && entry.document !== document) {
      this.discard(id, entry, "页面已重新打开");
      entry = undefined;
    }
    const reused = !!entry;
    if (!entry) {
      if (epoch || ack !== 0) throw Error("会话已过期");
      while (this.sessions.size >= this.limits.sessions) {
        if (!this.evictDetached()) throw Error("会话数量已达上限");
      }
      entry = {
        document,
        epoch: randomUUID(),
        window: this.create(),
        owner,
        events: new Map(),
        bytes: 0,
        head: 0,
        ack: 0,
        clientAck: 0,
      };
      this.sessions.set(id, entry);
      this.observe?.("create", id, document, { sessions: this.sessions.size });
      const created = entry;
      void entry.window.catch(() =>
        this.discard(id, created, "页面初始化失败"),
      );
    }
    const current = entry;
    if (!Number.isSafeInteger(ack) || ack < current.ack || ack > current.head)
      throw Error("恢复序号无效");
    this.observe?.("attach", id, document, { reused, replaced: !!current.transport, detachedMs: current.detachedAt === undefined ? 0 : Date.now() - current.detachedAt });
    current.transport?.close();
    clearTimeout(current.timer);
    current.timer = undefined;
    current.detachedAt = undefined;
    current.transport = undefined;
    current.owner = owner;
    const valid = () => this.sessions.get(id) === current;
    const isCurrent = () => valid() && current.owner === owner;
    const acknowledge = (value: number) => {
      if (
        !isCurrent() ||
        !Number.isSafeInteger(value) ||
        value < current.ack ||
        value > current.head
      )
        throw Error("确认序号无效");
      for (const [seq, data] of current.events) {
        if (seq > value) break;
        const size = Buffer.byteLength(data);
        current.events.delete(seq);
        current.bytes -= size;
        this.bytes -= size;
      }
      current.ack = value;
    };
    acknowledge(ack);
    const send = (payload: unknown) => {
      if (!valid()) return;
      const data = JSON.stringify({
        type: "renderer-event",
        seq: current.head + 1,
        payload,
      });
      const size = Buffer.byteLength(data);
      if (current.bytes + size > this.limits.sessionBytes || size > this.limits.totalBytes) {
        this.discard(id, current, "当前页面未确认的数据已达上限");
        return;
      }
      // Reclaim detached pages before an active page can hit the shared budget.
      while (this.bytes + size > this.limits.totalBytes) {
        if (!this.evictDetached()) {
          this.discard(id, current, "恢复缓存已达上限");
          return;
        }
        if (!valid()) return;
      }
      current.events.set(++current.head, data);
      current.bytes += size;
      this.bytes += size;
      current.transport?.send(JSON.parse(data));
    };
    return {
      window: current.window,
      reused,
      isCurrent,
      send,
      acknowledge,
      ready: () => {
        if (!isCurrent()) return;
        this.observe?.("replay", id, document, { events: current.events.size, bufferedBytes: current.bytes, head: current.head, ack: current.ack });
        current.transport = transport;
        transport.send({
          type: "renderer-ready",
          epoch: current.epoch,
          clientAck: current.clientAck,
        });
        for (const data of current.events.values())
          transport.send(JSON.parse(data));
        transport.send({ type: "renderer-caught-up", head: current.head });
      },
      accept: (seq: number, dispatch: () => void) => {
        if (!isCurrent()) return;
        if (
          !Number.isSafeInteger(seq) ||
          seq < 1 ||
          seq > current.clientAck + 1
        )
          throw Error("指令序号不连续");
        // Reserve before dispatch: retries never invoke the native command twice.
        if (seq === current.clientAck + 1) {
          current.clientAck = seq;
          dispatch();
        }
        transport.send({
          type: "renderer-command-ack",
          seq: current.clientAck,
        });
      },
      release: () => {
        if (!isCurrent() || current.timer) return;
        this.observe?.("release", id, document, { graceMs: this.limits.graceMs, bufferedBytes: current.bytes });
        current.transport = undefined;
        current.detachedAt = Date.now();
        current.timer = setTimeout(
          () => this.discard(id, current, "恢复窗口已过期"),
          this.limits.graceMs,
        );
        current.timer.unref();
      },
      expire: (reason: string) => {
        if (isCurrent()) this.discard(id, current, reason);
      },
    };
  }
}
