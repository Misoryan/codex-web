import { Console } from "node:console";
import { Writable } from "node:stream";
import { BoundedLogDestination } from "./log-storage";

export function installProcessLogging(directory: string) {
  const destination = new BoundedLogDestination(directory, "console", "log");
  const output = new Writable({
    write(chunk, _encoding, callback) {
      destination.write(chunk);
      callback();
    },
  });
  const previous = globalThis.console;
  globalThis.console = new Console({ stdout: output, stderr: output });
  // Direct writes by dependencies can outlive the parent's redirected pipe.
  // These handlers cover only output streams; application errors still surface.
  let outputFailures = 0;
  const outputError = () => { outputFailures++; };
  process.stdout.on("error", outputError);
  process.stderr.on("error", outputError);
  return {
    get droppedRecords() { return destination.droppedRecords + outputFailures; },
    async close() {
      globalThis.console = previous;
      process.stdout.off("error", outputError);
      process.stderr.off("error", outputError);
      output.end();
      await destination.close();
    },
  };
}
