import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Opt-in usage telemetry: counters only, sent as OTLP/HTTP JSON metrics to ALICE_TELEMETRY_ENDPOINT.
 * docs/telemetry.md lists every field. Counts gather in memory and go out in one batch per interval; a send that fails
 * is dropped, never retried, and never reaches the request or run that produced the count.
 */

/** Every counter Alice sends. */
export const telemetryCounters = ["alice.runs.started", "alice.runs.finished", "alice.runs.failed", "alice.runs.stopped", "alice.merges", "alice.pull_requests.opened", "alice.doctor.failures", "alice.server.errors"] as const;
export type TelemetryCounter = typeof telemetryCounters[number];

/** `alice doctor` check names. Board checks are named after their repository path, so they all count as "board". */
export const doctorCheckNames = ["node", "git", "git identity", "pi", "pi models", "worktrunk", "gh", "data dir", "server lock", "server", "board", "alice", "alice server"] as const;
export type DoctorCheckName = typeof doctorCheckNames[number];

/** The only data point attributes, by counter. Anything else is never recorded. */
type Attributes = { "doctor.check"?: DoctorCheckName; "error.type"?: string };

type Post = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export type TelemetryOptions = {
  /** OTLP/HTTP base URL; `/v1/metrics` is appended unless it is already there. Empty or unset turns telemetry off and hides the setting. */
  endpoint: string | undefined;
  /** The Settings toggle, read on every count and send so turning it off applies at once. */
  enabled: () => boolean;
  /** Where the install ID file lives. */
  dataDir: string;
  version: string;
  platform?: NodeJS.Platform;
  intervalMs?: number;
  post?: Post;
  now?: () => number;
};

/** OTel's os.type values for the platforms Alice runs on. */
function osType(platform: NodeJS.Platform): string {
  return platform === "win32" ? "windows" : platform === "darwin" || platform === "linux" || platform === "freebsd" || platform === "openbsd" ? platform : "other";
}

/** Error class names are code, never user data; anything that does not look like one is reported as plain Error. */
export function errorType(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : "";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "Error";
}

/** Maps a doctor check name to the reported one, or undefined for a name Alice does not know. */
export function doctorCheck(name: unknown): DoctorCheckName | undefined {
  if (typeof name !== "string") return undefined;
  const normalized = name.startsWith("board ") ? "board" : name;
  return (doctorCheckNames as readonly string[]).includes(normalized) ? normalized as DoctorCheckName : undefined;
}

export class Telemetry {
  private readonly url: string | null;
  private readonly post: Post;
  private readonly now: () => number;
  private readonly intervalMs: number;
  /** Pending counts keyed by counter and attributes, since `windowStart`. */
  private pending = new Map<string, { name: TelemetryCounter; attributes: Attributes; count: number }>();
  private windowStart: number;
  private timer: NodeJS.Timeout | undefined;
  private sending: Promise<void> | undefined;
  private installId: string | undefined;

  constructor(private readonly options: TelemetryOptions) {
    const endpoint = options.endpoint?.trim();
    this.url = endpoint ? (/\/v1\/metrics\/?$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/+$/, "")}/v1/metrics`) : null;
    this.post = options.post ?? fetch;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.windowStart = this.now();
  }

  /** Whether an endpoint is configured; without one the setting is hidden and nothing is ever sent. */
  get available(): boolean { return this.url !== null; }

  private get active(): boolean {
    if (!this.url) return false;
    try { return this.options.enabled(); } catch { return false; }
  }

  /** Adds one to a counter. Synchronous and cheap; never throws. */
  count(name: TelemetryCounter, attributes: Attributes = {}): void {
    if (!this.active) { if (this.pending.size) this.discard(); return; }
    const key = `${name}\u0000${JSON.stringify(attributes)}`;
    const entry = this.pending.get(key);
    if (entry) entry.count++;
    else this.pending.set(key, { name, attributes, count: 1 });
  }

  /** Forgets every pending count, for when the operator turns telemetry off. */
  discard(): void {
    this.pending = new Map();
    this.windowStart = this.now();
  }

  start(): void {
    if (!this.url || this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.intervalMs);
    this.timer.unref();
  }

  /** Sends the pending counts in one request. Resolves once it is done or has failed; never rejects. */
  flush(): Promise<void> {
    if (this.sending) return this.sending;
    const batch = [...this.pending.values()], start = this.windowStart, end = this.now();
    this.pending = new Map();
    this.windowStart = end;
    // Counts gathered before the toggle went off are dropped with it.
    if (!batch.length || !this.active) return Promise.resolve();
    this.sending = (async () => {
      try {
        const res = await this.post(this.url!, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(this.payload(batch, start, end)),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) console.debug(`Telemetry endpoint returned ${res.status}; dropped ${batch.length} counts`);
      } catch (error) {
        console.debug(`Telemetry send failed; dropped ${batch.length} counts: ${error instanceof Error ? error.message : String(error)}`);
      } finally { this.sending = undefined; }
    })();
    return this.sending;
  }

  /** Stops the timer and sends what is pending, waiting at most `timeoutMs`. */
  async shutdown(timeoutMs = 2_000): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    // Counts recorded while a send was in flight go out in the next one, until nothing is left or the deadline passes.
    const drain = async () => { do await this.flush(); while (this.pending.size && this.active); };
    await Promise.race([drain(), new Promise(resolve => setTimeout(resolve, timeoutMs).unref())]);
  }

  /** A random ID kept in the data directory, created the first time a batch is sent. */
  private id(): string {
    if (this.installId) return this.installId;
    const file = join(this.options.dataDir, "telemetry-id");
    try {
      const stored = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
      if (/^[0-9a-f-]{36}$/.test(stored)) return this.installId = stored;
    } catch { /* replaced below */ }
    this.installId = randomUUID();
    try { writeFileSync(file, `${this.installId}\n`, { mode: 0o600 }); } catch { /* still usable for this process */ }
    return this.installId;
  }

  /** The OTLP ExportMetricsServiceRequest, JSON-encoded: one delta, monotonic sum per counter. */
  private payload(batch: { name: TelemetryCounter; attributes: Attributes; count: number }[], start: number, end: number) {
    const string = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const nanos = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
    const metrics = telemetryCounters.flatMap(name => {
      const points = batch.filter(item => item.name === name);
      return points.length ? [{
        name,
        sum: {
          aggregationTemporality: 1,
          isMonotonic: true,
          dataPoints: points.map(point => ({
            attributes: Object.entries(point.attributes).map(([key, value]) => string(key, value as string)),
            startTimeUnixNano: nanos(start),
            timeUnixNano: nanos(end),
            asInt: String(point.count),
          })),
        },
      }] : [];
    });
    return {
      resourceMetrics: [{
        resource: { attributes: [string("service.name", "alice"), string("service.version", this.options.version), string("os.type", osType(this.options.platform ?? process.platform)), string("alice.install.id", this.id())] },
        scopeMetrics: [{ scope: { name: "alice" }, metrics }],
      }],
    };
  }
}

/**
 * Classifies a finished run for telemetry: Review is finished, an operator's Stop is stopped, anything else failed.
 * The Worker records a stop as a failure whose error names the "manual stop" it sent.
 */
export function runOutcome(run: { status: string; error: string | null }): "alice.runs.finished" | "alice.runs.failed" | "alice.runs.stopped" | null {
  if (run.status === "review") return "alice.runs.finished";
  if (run.status !== "failed") return null;
  return /Alice sent SIGTERM: manual stop/.test(run.error ?? "") ? "alice.runs.stopped" : "alice.runs.failed";
}
