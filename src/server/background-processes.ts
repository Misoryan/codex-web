import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// Native Desktop helpers also spawn processes; hiding the Web launcher alone
// does not hide their console windows.
export function hideBackgroundProcessWindows(): void {
  if (process.platform !== "win32") return;
  const prototype = childProcess.ChildProcess.prototype as unknown as {
    spawn: (options: Record<string, unknown>) => unknown;
  };
  const spawn = prototype.spawn;
  prototype.spawn = function (options) {
    return spawn.call(this, { ...options, windowsHide: true });
  };
  const methods = childProcess as unknown as Record<string, (...args: any[]) => any>;
  for (const name of ["spawnSync", "execFileSync", "execSync"]) {
    const original = methods[name]!;
    methods[name] = function (...args) {
      const index = name === "execSync" || !Array.isArray(args[1]) ? 1 : 2;
      args[index] = { ...args[index], windowsHide: true };
      return original.apply(this, args);
    };
  }
  syncBuiltinESMExports();
}
