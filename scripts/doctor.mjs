// `bakery-cli doctor`: checks the tools, data directory, server and boards Bakery depends on.
// Local checks describe the machine running the CLI; board repository checks only run when the
// server is on this machine, because a remote server's paths are on its own disk.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serviceCheck } from "./service.mjs";
import { formatVersion } from "./version.mjs";
import { dataDir } from "../server/legacy-names.ts";

// Bare names like `pi` are npm `.cmd` shims on Windows, which only a shell can run.
function run(bin, args, timeout = 20_000) {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout, shell: process.platform === "win32", env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" } });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  // execvp reports EACCES instead of ENOENT for a missing binary when a PATH directory is unreadable.
  if (result.error?.code === "EACCES") return { missing: true, ok: false, output, hint: "not found or not executable" };
  if (result.error?.code === "ENOENT" || (process.platform === "win32" && result.status !== 0 && /not recognized/.test(output))) return { missing: true, ok: false, output };
  if (result.error) return { ok: false, output: result.error.message };
  return { ok: result.status === 0, output };
}

const firstLine = text => text.split("\n").find(line => line.trim())?.trim() ?? "";

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function nodeCheck() {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 24 ? { status: "pass", name: "node", detail: `v${process.versions.node}` }
    : { status: "fail", name: "node", detail: `v${process.versions.node}; Bakery needs Node 24 or newer` };
}

function gitChecks() {
  const version = run("git", ["--version"]);
  if (!version.ok) return [{ status: "fail", name: "git", detail: version.missing ? "git not found on PATH" : firstLine(version.output) }];
  // Approve commits on the card branch, so git needs an identity to commit with.
  const ident = run("git", ["var", "GIT_COMMITTER_IDENT"]);
  return [
    { status: "pass", name: "git", detail: firstLine(version.output) },
    ident.ok ? { status: "pass", name: "git identity", detail: firstLine(ident.output).replace(/>.*$/, ">") }
      : { status: "fail", name: "git identity", detail: "git has no committer name or email; set git config --global user.name and user.email" },
  ];
}

function piChecks(env) {
  const bin = env.BAKERY_PI_BIN ?? "pi";
  const version = run(bin, ["--version"]);
  if (!version.ok) return [{ status: "fail", name: "pi", detail: version.missing ? `${bin} ${version.hint ?? "not found"}; install Pi or set BAKERY_PI_BIN` : `${bin} --version failed: ${firstLine(version.output)}` }];
  const list = run(bin, ["--list-models"], 60_000);
  // Same table shape the server parses: a "provider model ..." header, then one model per line.
  const models = list.ok ? list.output.split("\n").map(line => line.trim().split(/\s+/)).filter(([provider, model]) => provider && model && provider !== "provider") : [];
  return [
    { status: "pass", name: "pi", detail: `${bin} ${firstLine(version.output)}` },
    models.length ? { status: "pass", name: "pi models", detail: `${models.length} available` }
      : { status: "fail", name: "pi models", detail: list.ok ? "pi lists no models; configure a provider in Pi" : `${bin} --list-models failed: ${firstLine(list.output)}` },
  ];
}

function wtCheck(env) {
  const bin = env.BAKERY_WT_BIN ?? "wt";
  if (!bin) return { status: "pass", name: "worktrunk", detail: "turned off (BAKERY_WT_BIN is empty)" };
  const version = run(bin, ["--version"]);
  return version.ok ? { status: "pass", name: "worktrunk", detail: `${bin} ${firstLine(version.output)}` }
    : { status: "warn", name: "worktrunk", detail: `${bin} not usable; worktree hooks won't run (optional)` };
}

// gh only matters on GitHub pull request boards, so it fails only when one exists.
function ghCheck(env, boards) {
  const bin = env.BAKERY_GH_BIN || "gh";
  const needed = boards?.filter(board => board.integration === "github-pr").map(board => board.repo) ?? [];
  const problem = status => ({ status: needed.length ? "fail" : "warn", name: "gh", detail: `${status}; ${needed.length ? `needed by ${needed.join(", ")}` : "needed only for GitHub pull request boards"}` });
  const auth = run(bin, ["auth", "status"]);
  if (auth.missing) return problem(`${bin} not found`);
  if (!auth.ok) return problem(`gh auth status failed: ${firstLine(auth.output)}`);
  return { status: "pass", name: "gh", detail: "signed in" };
}

function dataDirChecks(env) {
  const dir = dataDir(env);
  let existing = dir;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  try { accessSync(existing, constants.W_OK); }
  catch { return [{ status: "fail", name: "data dir", detail: `${existing} is not writable (data dir ${dir})` }]; }
  const checks = [{ status: "pass", name: "data dir", detail: existing === dir ? dir : `${dir} (will be created)` }];
  const lock = join(dir, "server.lock");
  if (existsSync(lock)) {
    const pid = Number(/^\s*(\d+)\s*$/.exec(readFileSync(lock, "utf8"))?.[1]);
    checks.push(!pid ? { status: "warn", name: "server lock", detail: `${lock} has no PID; remove it if no server is starting` }
      : alive(pid) ? { status: "pass", name: "server lock", detail: `held by running PID ${pid}` }
      : { status: "pass", name: "server lock", detail: `stale lock from PID ${pid}; the next server takes it over` });
  }
  return checks;
}

function boardChecks(board, local, host) {
  // A remote board's path is on the server's disk, so name the host to keep it from reading as a local path.
  const name = `board ${local ? "" : `${host}:`}${board.repo}`;
  if (local) {
    if (!existsSync(board.repo)) return [{ status: "fail", name, detail: "repository path does not exist; edit the board's path" }];
    const head = run("git", ["-C", board.repo, "rev-parse", "--verify", "HEAD"]);
    if (!head.ok) return [{ status: "fail", name, detail: "not a Git repository with a commit; worktrees start from HEAD" }];
  }
  const problems = [
    board.integrationError && { status: "fail", name, detail: `integration: ${board.integrationError}` },
    board.integrationWarning && { status: "warn", name, detail: `integration: ${board.integrationWarning}` },
    board.autoPickupError && { status: "warn", name, detail: `pickup paused: ${board.autoPickupError}` },
  ].filter(Boolean);
  return problems.length ? problems : [{ status: "pass", name, detail: `${board.integration ?? "local"} integration` }];
}

// Values that can carry credentials print as "set (hidden)": doctor output gets pasted into bug reports.
const SECRET = /TOKEN|SECRET|KEY|PASSWORD|WEBHOOK|ENDPOINT/;

/** The BAKERY_* variables this CLI sees. A remote server's own environment stays on its machine. */
function envInfo(env) {
  const names = Object.keys(env).filter(name => name.startsWith("BAKERY_")).sort();
  if (!names.length) return [{ status: "info", name: "env", detail: "no BAKERY_* variables set" }];
  return names.map(name => ({ status: "info", name: `env ${name}`, detail: SECRET.test(name) ? "set (hidden)" : env[name] }));
}

/** What the server reports about itself: host, build features, run state and the settings that change runs. */
function serverInfo(status, settings) {
  const rows = [];
  if (status) {
    if (status.hostname) rows.push({ name: "server host", detail: status.hostname });
    if (status.features) rows.push({ name: "server features", detail: Object.entries(status.features).map(([name, on]) => `${name} ${on ? "on" : "off"}`).join(", ") });
    rows.push({ name: "server runs", detail: `${status.activeRuns ?? 0} active${status.draining ? ", draining for an update" : ""}` });
  }
  if (settings) {
    const models = Object.entries(settings.agentModels ?? {}).map(([role, { model, thinking } = {}]) => `${role} ${model || "default"}${thinking ? ` (${thinking})` : ""}`);
    if (models.length) rows.push({ name: "server models", detail: models.join(", ") });
    rows.push({ name: "server telemetry", detail: !settings.telemetryAvailable ? "no endpoint" : settings.telemetryEnabled ? "on" : "off" });
    rows.push({ name: "server discord", detail: settings.discordWebhookUrl ? "webhook set" : "no webhook" });
  }
  return rows.map(row => ({ status: "info", ...row }));
}

/** Runs every check. `fetchBoards` resolves to the server's boards or throws when it is unreachable. */
export async function doctor({ env = process.env, origin, local, fetchBoards, fetchStatus, fetchSettings, cliVersion, cliPath }) {
  let boards = null, serverCheck;
  try {
    boards = await fetchBoards();
    serverCheck = { status: "pass", name: "server", detail: `${origin.origin} (${local ? "local" : "remote"}, ${boards.length} board${boards.length === 1 ? "" : "s"})` };
  } catch (error) {
    serverCheck = { status: "fail", name: "server", detail: `${error instanceof Error ? error.message : error}; ${local ? "start it with bakery-cli service install, npm start or npm run dev" : "check that the server is up and BAKERY_URL is right"}` };
  }
  // Tools, the data directory and repository paths belong to the machine the server runs on.
  const machine = local ? [nodeCheck(), ...gitChecks(), ...piChecks(env), wtCheck(env), ghCheck(env, boards), ...dataDirChecks(env), serviceCheck(env)].filter(Boolean) : [];
  // The versions come first. A remote server can run a different version than this CLI, so print both.
  const versions = [];
  if (cliVersion) versions.push({ status: "pass", name: "bakery-cli", detail: formatVersion(cliVersion) });
  const status = boards && fetchStatus ? await fetchStatus().catch(() => null) : null;
  if (!local && fetchStatus) versions.push(status ? { status: "pass", name: "bakery server", detail: formatVersion(status) } : { status: "warn", name: "bakery server", detail: "version unavailable" });
  const settings = boards && fetchSettings ? await fetchSettings().catch(() => null) : null;
  // Diagnostics come last as INFO rows: they never pass or fail, and the summary line ignores them.
  const info = [...(cliPath ? [{ status: "info", name: "cli path", detail: cliPath }] : []), ...envInfo(env), ...serverInfo(status, settings)];
  // The server line goes right after the versions so the instance being checked is the first thing read.
  return [...versions, serverCheck, ...machine, ...(boards ?? []).flatMap(board => boardChecks(board, local, origin.hostname)), ...info];
}

export function report(checks) {
  const label = { pass: "PASS", warn: "WARN", fail: "FAIL", info: "INFO" };
  const count = status => checks.filter(check => check.status === status).length;
  return [
    ...checks.map(check => `${label[check.status]}\t${check.name}\t${check.detail}`),
    `${count("pass")} passed, ${count("warn")} warnings, ${count("fail")} failed`,
  ];
}
