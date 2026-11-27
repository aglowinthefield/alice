import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Finds `bin` the way Windows would: each PATH entry, trying every PATHEXT extension.
 * Node can't spawn a bare name like `pi` there, because npm installs `pi.cmd`.
 */
function findOnWindows(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  const exts = ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)];
  const dirs = /[\\/]/.test(bin) || isAbsolute(bin) ? [""] : (env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
  for (const dir of dirs) for (const ext of exts) {
    const candidate = dir ? join(dir, bin + ext) : bin + ext;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The JavaScript file an npm `.cmd` shim runs, e.g. `"%dp0%\node_modules\pkg\dist\cli.js"`. */
function shimScript(shim: string): string | undefined {
  let text: string;
  try { text = readFileSync(shim, "utf8"); } catch { return undefined; }
  const relative = /"%(?:~dp0|dp0%)[\\/]?([^"%]+?\.[cm]?js)"/i.exec(text)?.[1];
  if (!relative) return undefined;
  const script = resolve(dirname(shim), relative.replaceAll("\\", "/"));
  return existsSync(script) ? script : undefined;
}

/**
 * Command and arguments to pass to spawn/execFile for `bin`. Unchanged off Windows.
 * On Windows an npm `.cmd` shim becomes `node script.js ...`, because Node refuses to spawn
 * `.cmd` files without a shell and a shell would mangle prompts containing quotes and newlines.
 */
export function command(bin: string, args: string[], platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  if (platform !== "win32") return [bin, args];
  const file = findOnWindows(bin, env);
  if (!file) return [bin, args];
  if (!/\.(cmd|bat)$/i.test(file)) return [file, args];
  const script = shimScript(file);
  return script ? [process.execPath, [script, ...args]] : [file, args];
}

/**
 * When process `pid` started, as an opaque string that changes if the PID is reused, or null when the process is gone
 * or the platform has no cheap way to ask. Linux reads the start tick from `/proc`; macOS asks `ps` (second resolution).
 */
export function processStartTime(pid: number, platform: string = process.platform): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22 (starttime). The command name in field 2 may hold spaces and parentheses, so count from its end.
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return start ? `linux:${start}` : null;
    }
    if (platform === "darwin") {
      const start = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" }, timeout: 5000 }).trim();
      return start ? `darwin:${start}` : null;
    }
  } catch { /* Gone, or not ours to inspect. */ }
  return null;
}

/**
 * Signals the process group led by `pid`, but only while `pid` is still the process that started at `startedAt`, so
 * a reused PID is never signalled. False when the leader is gone, was replaced, or the signal failed.
 */
export function signalGroup(pid: number, startedAt: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (process.platform === "win32" || processStartTime(pid) !== startedAt) return false;
  try { process.kill(-pid, signal); return true; } catch { return false; }
}

/** Whether any process is left in the process group `pgid`. A PID still in use as a group id is never reused. */
export function groupAlive(pgid: number): boolean {
  if (process.platform === "win32") return false;
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
