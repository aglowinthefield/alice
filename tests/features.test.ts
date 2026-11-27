import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featureSwitches, readFeatures } from "../src/features.js";
import { Board } from "../server/board.js";

test("both features are off unless their switch is 1", () => {
  assert.deepEqual(readFeatures({}), { sentinels: false, pullRequests: false });
  assert.deepEqual(readFeatures({ ALICE_FEATURE_SENTINELS: "1" }), {
    sentinels: true,
    pullRequests: false,
  });
  assert.deepEqual(
    readFeatures({
      ALICE_FEATURE_PULL_REQUESTS: "1",
      ALICE_FEATURE_SENTINELS: "0",
    }),
    { sentinels: false, pullRequests: true },
  );
  assert.deepEqual(
    readFeatures({
      ALICE_FEATURE_PULL_REQUESTS: "",
      ALICE_FEATURE_SENTINELS: " 1 ",
    }),
    { sentinels: true, pullRequests: false },
  );
});

test("a switch that is not 0 or 1 is rejected rather than read as off", () => {
  assert.throws(
    () => readFeatures({ ALICE_FEATURE_SENTINELS: "true" }),
    /ALICE_FEATURE_SENTINELS must be 0 or 1/,
  );
  assert.throws(
    () => readFeatures({ [featureSwitches.pullRequests]: "yes" }),
    /ALICE_FEATURE_PULL_REQUESTS must be 0 or 1/,
  );
});

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

type Api = (
  path: string,
  method?: string,
  input?: unknown,
) => Promise<{ status: number; data: any }>;

/** Runs a real server on `dataDir` with the given feature switches, and stops it afterwards. */
async function withServer(
  home: string,
  dataDir: string,
  switches: { sentinels: boolean; pullRequests: boolean },
  work: (api: Api) => Promise<void>,
): Promise<void> {
  const port = await freePort(),
    url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ALICE_HOST: "",
        ALICE_ALLOWED_HOSTS: "",
        HOME: home,
        ALICE_DATA_DIR: dataDir,
        ALICE_PORT: String(port),
        ALICE_GH_BIN: "false",
        [featureSwitches.sentinels]: switches.sentinels ? "1" : "0",
        [featureSwitches.pullRequests]: switches.pullRequests ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stderr?.on("data", (chunk) => {
    log += chunk;
  });
  try {
    const end = Date.now() + 20_000;
    while (true) {
      if (child.exitCode !== null)
        throw new Error(
          `Server exited (sentinels=${switches.sentinels} pullRequests=${switches.pullRequests}): ${log.slice(-4000)}`,
        );
      try {
        await fetch(`${url}/api/boards`);
        break;
      } catch {
        /* not listening yet */
      }
      if (Date.now() > end) throw new Error("Server did not listen");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await work(async (path, method = "GET", input) => {
      const response = await fetch(`${url}/api${path}`, {
        method,
        headers: input ? { "Content-Type": "application/json" } : undefined,
        body: input ? JSON.stringify(input) : undefined,
      });
      return { status: response.status, data: (await response.json()) as any };
    });
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
  }
}

test("the server refuses a disabled feature in every combination and keeps its stored data", async () => {
  const home = mkdtempSync(join(tmpdir(), "alice-features-"));
  try {
    const repo = join(home, "code", "alpha"),
      dataDir = join(home, "data");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    let boardId = "",
      cardId = "";
    // Everything on first: a board set to GitHub pull requests, with automatic PRs and its two sentinels stored.
    await withServer(
      home,
      dataDir,
      { sentinels: true, pullRequests: true },
      async (api) => {
        boardId = (await api("/boards", "POST", { repo })).data.id;
        assert.equal(
          (
            await api(`/boards/${boardId}/settings`, "PATCH", {
              remoteUrl: "https://github.com/acme/widgets",
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await api(`/boards/${boardId}/settings`, "PATCH", {
              integration: "github-pr",
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await api(`/boards/${boardId}/settings`, "PATCH", {
              autoPullRequestEnabled: true,
            })
          ).status,
          200,
        );
        assert.equal(
          (await api(`/boards/${boardId}/sentinels`)).data.length,
          2,
        );
        cardId = (
          await api(`/boards/${boardId}/cards`, "POST", {
            title: "Local work",
            body: "x",
          })
        ).data.id;
        assert.ok(cardId);
      },
    );

    for (const [sentinels, pullRequests] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      await withServer(
        home,
        dataDir,
        { sentinels, pullRequests },
        async (api) => {
          const label = `sentinels=${sentinels} pullRequests=${pullRequests}`;
          assert.deepEqual(
            (await api("/status")).data.features,
            { sentinels, pullRequests },
            label,
          );

          const sentinelOff = {
            code: "feature_off",
            feature: "sentinels",
            error: "Sentinels are turned off in this Alice build. Build and start Alice with ALICE_FEATURE_SENTINELS=1 to use them.",
          };
          // Sentinels: the routes exist only with the feature, and the stored sentinels survive being off.
          const sentinelList = await api(`/boards/${boardId}/sentinels`);
          if (sentinels) {
            assert.equal(sentinelList.status, 200, label);
            assert.equal(
              sentinelList.data.length,
              2,
              `${label}: stored sentinels are back`,
            );
          } else {
            assert.equal(sentinelList.status, 404, label);
            assert.deepEqual(sentinelList.data, sentinelOff, label);
          }
          for (const [path, method, error] of [
            ["/sentinels/missing", "GET", "Sentinel not found"],
            ["/sentinels/missing/runs", "GET", "Sentinel not found"],
            ["/sentinels/missing/run", "POST", "Sentinel not found"],
            [`/boards/${boardId}/sentinels?view=list`, "PUT", "Not found"],
          ]) {
            assert.deepEqual(
              await api(path, method),
              { status: 404, data: sentinels ? { error } : sentinelOff },
              `${label}: ${method} ${path}`,
            );
          }

          // Pull requests: the board reads as local while off, but still remembers what was stored.
          const board = (await api("/boards")).data[0];
          assert.equal(
            board.integration,
            pullRequests ? "github-pr" : "local",
            label,
          );
          assert.equal(
            board.integrationConfigured,
            "github-pr",
            `${label}: the stored mode is kept`,
          );
          assert.equal(
            board.autoPullRequestEnabled,
            true,
            `${label}: the stored auto-PR choice is kept`,
          );
          for (const path of [
            `/boards/${boardId}/pull-requests`,
            `/boards/${boardId}/sync`,
            `/boards/${boardId}/local-merges`,
            `/boards/${boardId}/main/reset`,
            `/boards/${boardId}/cards/${cardId}/publish`,
            `/boards/${boardId}/cards/${cardId}/pr-draft`,
          ]) {
            const response = await api(
              path,
              path.endsWith("/pull-requests") ? "GET" : "POST",
              path.endsWith("pr-draft") ? { fingerprint: "x" } : undefined,
            );
            assert.equal(
              response.status === 404 && response.data.code === "feature_off",
              !pullRequests,
              `${label}: ${path} -> ${response.status} ${JSON.stringify(response.data)}`,
            );
          }
          const pullRequestsOff = {
            code: "feature_off",
            feature: "pullRequests",
            error: "GitHub pull requests are turned off in this Alice build. Build and start Alice with ALICE_FEATURE_PULL_REQUESTS=1 to use them.",
          };
          // Missing records keep the supported requests from attempting a merge or changing a card.
          for (const [path, method, error] of [
            ["/boards/missing/pull-requests/123456789/merge", "POST", "Board not found"],
            [`/boards/${boardId}/cards/missing/pull-request`, "PUT", "Card not found on this board"],
            [`/boards/${boardId}/cards/${cardId}/pr-draft?view=status`, "PUT", "Not found"],
          ]) {
            assert.deepEqual(
              await api(path, method),
              { status: 404, data: pullRequests ? { error } : pullRequestsOff },
              `${label}: ${method} ${path}`,
            );
          }
          if (!pullRequests) {
            const choose = await api(`/boards/${boardId}/settings`, "PATCH", {
              integration: "github-pr",
            });
            assert.equal(choose.status, 400, label);
            assert.match(
              choose.data.error,
              /ALICE_FEATURE_PULL_REQUESTS=1/,
              label,
            );
            const auto = await api(`/boards/${boardId}/settings`, "PATCH", {
              autoPullRequestEnabled: true,
            });
            assert.equal(auto.status, 400, label);
            assert.match(
              auto.data.error,
              /ALICE_FEATURE_PULL_REQUESTS=1/,
              label,
            );
            // A board set to pull requests must not fall back to a local merge behind the operator's back.
            const approve = await api(
              `/boards/${boardId}/cards/${cardId}/approve`,
              "POST",
              { fingerprint: "a".repeat(64) },
            );
            assert.equal(approve.status, 400, label);
            assert.match(
              approve.data.error,
              /turned off in this build, so Approve will not merge into local main/,
              label,
            );
          }

          // Normal card work needs neither feature.
          assert.equal(
            (await api(`/boards/${boardId}/cards`)).data.some(
              (card: { id: string }) => card.id === cardId,
            ),
            true,
            label,
          );
          assert.equal(
            (
              await api(`/boards/${boardId}/cards`, "POST", {
                title: `Another ${label}`,
                body: "x",
              })
            ).status,
            201,
            label,
          );
        },
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("with pull requests off, a board that chose Local merge approves locally as before", async () => {
  const home = mkdtempSync(join(tmpdir(), "alice-features-local-"));
  try {
    const repo = join(home, "code", "alpha"),
      dataDir = join(home, "data");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await withServer(
      home,
      dataDir,
      { sentinels: false, pullRequests: false },
      async (api) => {
        const board = (await api("/boards", "POST", { repo })).data;
        assert.equal(board.integration, "local");
        const card = (
          await api(`/boards/${board.id}/cards`, "POST", {
            title: "Local work",
            body: "x",
          })
        ).data;
        // Past the pull-request guard, Approve fails only on what a local merge needs (a reviewed run), never on the feature.
        const approve = await api(
          `/boards/${board.id}/cards/${card.id}/approve`,
          "POST",
          { fingerprint: "a".repeat(64) },
        );
        assert.doesNotMatch(
          approve.data.error ?? "",
          /turned off in this build/,
        );
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("with only Sentinels on, a fresh board with a GitHub remote is monitored and stays a local-merge board", async () => {
  const home = mkdtempSync(join(tmpdir(), "alice-features-sentinels-only-"));
  try {
    const repo = join(home, "code", "alpha"),
      dataDir = join(home, "data");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await withServer(
      home,
      dataDir,
      { sentinels: true, pullRequests: false },
      async (api) => {
        const boardId = (await api("/boards", "POST", { repo })).data.id;
        assert.equal(
          (await api(`/boards/${boardId}/sentinels`)).data.length,
          0,
          "no GitHub remote, nothing to monitor",
        );
        assert.equal(
          (
            await api(`/boards/${boardId}/settings`, "PATCH", {
              remoteUrl: "https://github.com/acme/widgets",
            })
          ).status,
          200,
        );
        const listed = await api(`/boards/${boardId}/sentinels`);
        assert.equal(listed.status, 200);
        assert.equal(
          listed.data.length,
          2,
          "both sentinels exist without pull requests",
        );
        const board = (await api("/boards")).data[0];
        assert.equal(board.integration, "local");
        assert.equal(
          (
            await api(`/boards/${boardId}/settings`, "PATCH", {
              integration: "github-pr",
            })
          ).status,
          400,
          "delivery mode stays local",
        );
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("clearing the remote of a stored github-pr board is refused while pull requests are off, and the server stays up", async () => {
  const home = mkdtempSync(join(tmpdir(), "alice-features-remote-"));
  try {
    const repo = join(home, "code", "alpha"),
      dataDir = join(home, "data");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    let boardId = "";
    await withServer(
      home,
      dataDir,
      { sentinels: true, pullRequests: true },
      async (api) => {
        boardId = (await api("/boards", "POST", { repo })).data.id;
        await api(`/boards/${boardId}/settings`, "PATCH", {
          remoteUrl: "https://github.com/acme/widgets",
        });
        assert.equal(
          (
            await api(`/boards/${boardId}/settings`, "PATCH", {
              integration: "github-pr",
            })
          ).status,
          200,
        );
      },
    );
    await withServer(
      home,
      dataDir,
      { sentinels: true, pullRequests: false },
      async (api) => {
        const cleared = await api(`/boards/${boardId}/settings`, "PATCH", {
          remoteUrl: "",
        });
        assert.equal(cleared.status, 400);
        assert.match(cleared.data.error, /remote must stay a/);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(
          (await api(`/boards/${boardId}/sentinels`)).data.length,
          2,
          "still answering",
        );
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a stored GitHub sync error does not hold back automatic pickup while pull requests are off, and returns with them", () => {
  const dir = mkdtempSync(join(tmpdir(), "alice-features-pickup-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    const on = new Board(join(dir, "board.sqlite"), {
      sentinels: false,
      pullRequests: true,
    });
    const id = on.addRepo(repo).id;
    on.setRemoteUrl(id, "https://github.com/acme/widgets");
    on.setIntegration(id, "github-pr");
    on.setIntegrationError(id, "gh sync failed");
    on.setAutoPickup(id, true, 1);
    const card = on.createCard({ title: "Normal work", body: "x", repo });
    on.setStatus(card.id, "ready");
    assert.equal(
      on.listAutoPickupCandidates().length,
      0,
      "with pull requests on, the sync error pauses pickup",
    );
    const off = new Board(join(dir, "board.sqlite"), {
      sentinels: false,
      pullRequests: false,
    });
    assert.equal(
      off.listAutoPickupCandidates().length,
      1,
      "with them off, pickup is not held back",
    );
    assert.equal(off.getBoard(id)!.integrationError, "");
    assert.equal(
      on.getBoard(id)!.integrationError,
      "gh sync failed",
      "the stored error is kept for re-enabling",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
