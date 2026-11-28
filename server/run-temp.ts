import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, killTree } from "./platform.js";

const NAME = /^alice-run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Who made the directory: the Alice server and the Pi child, each as a pid plus start time so a reused pid doesn't count. */
const OWNER = ".alice-owner";
/**
 * After Pi exits, how long a tool process it left behind may hold its stdout open. Then Alice closes the pipes, so
 * 'close' fires and every caller's 'close' handler (a chat publishing screenshots, a run finishing) runs before the directory goes.
 */
const CLOSE_GRACE_MS = 2000;
// `/tmp`, not os.tmpdir(): macOS's per-user temp path is ~50 bytes, which pushes Unix socket paths (Chromium, tsx) past their ~104-byte cap.
const root = () => (process.platform === "win32" ? tmpdir() : "/tmp");

type Identity = { pid: number; start: string | null };
type Owner = { server: Identity; pi: Identity | null };
const live = new Map<ChildProcess, { done: Promise<void>; group: boolean }>();

export function runTempDir(id: string) { return join(root(), `alice-run-${id}`); }

/**
 * Spawns Pi with its own TMPDIR (TMP and TEMP on Windows), `<tmp>/alice-run-<id>`, and removes the directory once Pi
 * exits, however it ends. Whatever Pi and its tools leave there (browser profiles, clones, test scratch) goes with it,
 * instead of piling up in the shared temp directory. `id` is a UUID used for one spawn only: a run id or a fresh one.
 */
export function spawnPi(id: string, bin: string, args: string[], options: SpawnOptions): ChildProcess {
  const dir = runTempDir(id);
  // Not recursive: an existing path is someone else's, never adopted.
  mkdirSync(dir, { mode: 0o700 });
  const server = { pid: process.pid, start: startOf(process.pid) };
  let child: ChildProcess;
  try {
    writeOwner(dir, { server, pi: null });
    child = spawn(...command(bin, args), { ...options, env: { ...(options.env ?? process.env), TMPDIR: dir, TMP: dir, TEMP: dir } });
  } catch (error) { remove(dir); throw error; }
  let finish!: () => void, deadline: ReturnType<typeof setTimeout> | undefined, removed = false;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const cleanUp = () => {
    if (removed) return;
    removed = true; clearTimeout(deadline); remove(dir); live.delete(child); finish();
  };
  child.once("exit", () => {
    deadline = setTimeout(() => {
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      deadline = setTimeout(cleanUp, 1000);
    }, CLOSE_GRACE_MS);
  });
  // After the caller's own 'close' handlers, so they can still read what Pi left in the directory.
  child.once("close", () => setImmediate(cleanUp));
  child.once("error", () => { if (!child.pid) cleanUp(); });
  live.set(child, { done, group: !!options.detached && process.platform !== "win32" });
  if (child.pid) {
    try { writeOwner(dir, { server, pi: { pid: child.pid, start: startOf(child.pid) } }); }
    // Without the record a later sweep can't tell this Pi is alive, so it doesn't run. Its exit removes the directory.
    catch (error) { child.kill("SIGKILL"); throw error; }
  }
  return child;
}

/** Stops every Pi process still running and resolves once each one's directory is gone. Pi that ignores SIGTERM for 10 s is killed. */
export async function stopPi(): Promise<void> {
  const signal = (name: NodeJS.Signals) => {
    for (const [child, { group }] of live) {
      try { if (group && child.pid) process.kill(-child.pid, name); else killTree(child, name); } catch { killTree(child, name); }
    }
  };
  signal("SIGTERM");
  const force = setTimeout(() => signal("SIGKILL"), 10_000);
  await Promise.all([...live.values()].map(item => item.done));
  clearTimeout(force);
}

/**
 * Removes the run temp directories a Alice that stopped without cleaning up left behind (a crash, SIGKILL, power loss).
 * Only directories with Alice's name and owner record count, owned by this user. One stays while its server is alive
 * (a dev server, a test server) or while its Pi is still running, such as an orphaned chat or an interrupted card run.
 */
export function sweepRunTemp() {
  let names: string[];
  try { names = readdirSync(root()); } catch { return; }
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const dir = join(root(), name);
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) continue;
    } catch { continue; }
    const owner = readOwner(dir);
    if (!owner || alive(owner.server) || (owner.pi && alive(owner.pi))) continue;
    remove(dir);
  }
}

/** Best effort: a file a leftover tool process still holds open (Windows) must not fail the run, so this only logs. */
function remove(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (error) { console.error(`Could not remove ${dir}:`, error); }
}

function writeOwner(dir: string, owner: Owner) {
  writeFileSync(join(dir, `${OWNER}.tmp`), JSON.stringify(owner));
  renameSync(join(dir, `${OWNER}.tmp`), join(dir, OWNER));
}

function readOwner(dir: string): Owner | null {
  const valid = (item: unknown): item is Identity => !!item && Number.isInteger((item as Identity).pid) && (item as Identity).pid > 0;
  try {
    const owner = JSON.parse(readFileSync(join(dir, OWNER), "utf8")) as Owner;
    return valid(owner.server) && (owner.pi === null || valid(owner.pi)) ? owner : null;
  } catch { return null; }
}

/** A process's start time, which tells it apart from a later process given the same pid. Null where it can't be read. */
function startOf(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    }
    if (process.platform !== "win32") return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { /* Gone already, or no ps. */ }
  return null;
}

/** Whether the process still runs. When its start time can't be compared, a live pid counts, so a directory is never removed on a guess. */
function alive({ pid, start }: Identity) {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return false; }
  const now = start === null ? null : startOf(pid);
  return start === null || now === null || now === start;
}
