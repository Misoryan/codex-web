import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";

const FILE_BYTES = 10 * 1024 * 1024;
const QUEUE_BYTES = 1024 * 1024;
const RETAINED_FILES = 7;

// A single writer bounds both retained files and all pending writes. Logging
// failures are counted here, never reported through another failing log sink.
export class BoundedLogDestination {
  private handle?: FileHandle;
  private fileDate = "";
  private bytes = 0;
  private part = 0;
  private readonly run = `${process.pid}-${randomUUID()}`;
  private queue: Buffer[] = [];
  private pendingBytes = 0;
  private draining?: Promise<void>;
  private retryAt = 0;
  private dropped = 0;
  private closed = false;

  constructor(readonly directory: string, private prefix: "server" | "console", private extension: "jsonl" | "log") {}

  write(line: string | Buffer): void {
    if (this.closed) return;
    const length = Buffer.byteLength(line);
    if (Date.now() < this.retryAt || this.pendingBytes + length > QUEUE_BYTES) {
      this.dropped++;
      return;
    }
    this.queue.push(typeof line === "string" ? Buffer.from(line) : line);
    this.pendingBytes += length;
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = undefined; });
  }

  private async rotate(date: string): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
    await fs.mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, `${this.prefix}-${date}-${this.run}-${this.part++}.${this.extension}`);
    this.handle = await fs.open(file, "ax");
    this.fileDate = date;
    this.bytes = 0;
    const files = await Promise.all((await fs.readdir(this.directory))
      .filter(name => name.startsWith(`${this.prefix}-`) && name.endsWith(`.${this.extension}`))
      .map(async name => ({ name, time: (await fs.stat(path.join(this.directory, name))).mtimeMs })));
    const previous = files.filter(entry => path.join(this.directory, entry.name) !== file)
      .sort((a, b) => b.time - a.time);
    for (const entry of previous.slice(RETAINED_FILES - 1)) await fs.unlink(path.join(this.directory, entry.name));
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const line = this.queue.shift()!;
      try {
        const date = new Date().toISOString().slice(0, 10);
        if (!this.handle || this.fileDate !== date || this.bytes + line.length > FILE_BYTES) await this.rotate(date);
        await this.handle!.writeFile(line);
        this.bytes += line.length;
        this.pendingBytes -= line.length;
      } catch {
        this.dropped += this.queue.length + 1;
        this.queue = [];
        this.pendingBytes = 0;
        this.retryAt = Date.now() + 60_000;
        const failed = this.handle;
        this.handle = undefined;
        await failed?.close().catch(() => {});
      }
    }
  }

  get droppedRecords(): number { return this.dropped; }

  async flush(): Promise<void> { await this.draining; }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close().catch(() => {});
  }
}

export class MonitoringDestination extends BoundedLogDestination {
  constructor(directory: string) { super(directory, "server", "jsonl"); }
}
