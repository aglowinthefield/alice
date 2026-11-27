import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseModelList } from "./agent-models.js";
import { spawnPi } from "./run-temp.js";

export type ModelList = { models: string[]; error?: string };
/** Per stream, as execFile's maxBuffer was. */
const MAX_OUTPUT_BYTES = 4_000_000;

/**
 * Lists the models `pi --list-models` reports. Listing can take seconds (Pi may refresh provider catalogs), so a
 * success is cached for 10 minutes and concurrent callers share one child. Failures are not cached; the UI offers no suggestions.
 */
export function modelLister(piBin: string, timeoutMs = 20_000): () => Promise<ModelList> {
  let cache: { models: string[]; at: number } | undefined, request: Promise<ModelList> | undefined;
  const failed = (why: string): ModelList => ({ models: [], error: `Could not list Pi models: ${why.slice(0, 300)}` });
  const list = () => new Promise<ModelList>(resolve => {
    let child: ChildProcess;
    try { child = spawnPi(randomUUID(), piBin, ["--list-models"], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { resolve(failed(error instanceof Error ? error.message : String(error))); return; }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, stderr = "", settled = false;
    const settle = (result: ModelList) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    // Close our ends of the pipes too, so a tool process holding them open can't keep the request waiting.
    const stop = (why: string) => { child.kill("SIGKILL"); child.stdout?.destroy(); child.stderr?.destroy(); settle(failed(why)); };
    const timer = setTimeout(() => stop("timed out"), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > MAX_OUTPUT_BYTES) stop("output exceeded 4 MB"); else stdout.push(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_OUTPUT_BYTES) stop("error output exceeded 4 MB"); else stderr = (stderr + chunk.toString()).slice(-1000); });
    child.once("error", error => settle(failed(error.message)));
    child.once("close", code => {
      if (settled) return;
      if (code !== 0) { settle(failed(`pi exited ${code}${stderr.trim() ? `: ${stderr.trim().split("\n")[0]}` : ""}`)); return; }
      cache = { models: parseModelList(Buffer.concat(stdout).toString("utf8")), at: Date.now() };
      settle({ models: cache.models });
    });
  });
  return () => {
    if (cache && Date.now() - cache.at < 10 * 60_000) return Promise.resolve({ models: cache.models });
    // Cleared only once this request settles, so a failure, even one thrown before Pi started, is never served twice.
    return request ??= list().finally(() => { request = undefined; });
  };
}
