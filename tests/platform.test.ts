import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { command, killTree, posixShell, worktrunkVersion } from "../server/platform.js";

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "alice-platform-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("commands are untouched off Windows", () => {
  assert.deepEqual(command("pi", ["-x"], "linux"), ["pi", ["-x"]]);
});

test("on Windows an npm .cmd shim runs its script under node", () =>
  withDir((dir) => {
    mkdirSync(join(dir, "node_modules", "pi", "dist"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pi", "dist", "cli.js"), "");
    // Named in PATHEXT case: Windows matches extensions case-insensitively, but this test may run on a case-sensitive disk.
    writeFileSync(
      join(dir, "pi.CMD"),
      '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pi\\dist\\cli.js" %*\r\n',
    );
    const [file, args] = command(
      "pi",
      ["--print", 'a "quoted"\nprompt'],
      "win32",
      { PATH: dir, PATHEXT: ".EXE;.CMD" },
    );
    assert.equal(file, process.execPath);
    assert.deepEqual(args, [
      join(dir, "node_modules", "pi", "dist", "cli.js"),
      "--print",
      'a "quoted"\nprompt',
    ]);
  }));

test("on Windows an npm shim wins over the extensionless sh script npm installs beside it", () =>
  withDir((dir) => {
    mkdirSync(join(dir, "node_modules", "pi", "dist"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pi", "dist", "cli.js"), "");
    writeFileSync(
      join(dir, "pi"),
      '#!/bin/sh\nexec node "$basedir/node_modules/pi/dist/cli.js" "$@"\n',
    );
    writeFileSync(
      join(dir, "pi.CMD"),
      '@ECHO off\r\n"%dp0%\\node_modules\\pi\\dist\\cli.js" %*\r\n',
    );
    assert.equal(
      command("pi", [], "win32", { PATH: dir, PATHEXT: ".EXE;.CMD" })[0],
      process.execPath,
    );
    assert.equal(
      command(join(dir, "pi"), [], "win32", {
        PATH: "",
        PATHEXT: ".EXE;.CMD",
      })[0],
      process.execPath,
    );
  }));

test("on Windows an .exe on PATH is resolved and an unknown name is left alone", () =>
  withDir((dir) => {
    writeFileSync(join(dir, "wt.EXE"), "");
    assert.deepEqual(
      command("wt", ["--version"], "win32", { PATH: dir, PATHEXT: ".EXE" }),
      [join(dir, "wt.EXE"), ["--version"]],
    );
    assert.deepEqual(
      command("nope", [], "win32", { PATH: dir, PATHEXT: ".EXE" }),
      ["nope", []],
    );
  }));

// Windows Terminal's `wt.exe` app alias opens a dialog for `--version`, so Alice must not run it to ask.
// The fake is a shell script, which only runs off Windows.
test("on Windows a wt under WindowsApps is never run to check for Worktrunk", { skip: process.platform === "win32" && "needs a shebang script" }, () =>
  withDir((dir) => {
    const marker = join(dir, "ran");
    for (const sub of ["WindowsApps", "bin"]) {
      mkdirSync(join(dir, sub));
      writeFileSync(join(dir, sub, "wt.EXE"), `#!/bin/sh\necho ${sub} >> '${marker}'\necho 'wt v0.9.0'\n`);
      chmodSync(join(dir, sub, "wt.EXE"), 0o755);
    }
    assert.equal(worktrunkVersion("wt", "win32", { PATH: join(dir, "WindowsApps"), PATHEXT: ".EXE" }), undefined);
    assert.ok(!existsSync(marker));
    assert.equal(worktrunkVersion("wt", "win32", { PATH: join(dir, "bin"), PATHEXT: ".EXE" }), "wt v0.9.0");
  }));

test("on Windows sh.exe is found beside a git.exe that PATH resolves, wherever Git is installed", () =>
  withDir((dir) => {
    mkdirSync(join(dir, "Git", "cmd"), { recursive: true });
    mkdirSync(join(dir, "Git", "usr", "bin"), { recursive: true });
    writeFileSync(join(dir, "Git", "cmd", "git.EXE"), "");
    writeFileSync(join(dir, "Git", "usr", "bin", "sh.exe"), "");
    const env = { PATH: join(dir, "Git", "cmd"), PATHEXT: ".EXE;.CMD" };
    assert.equal(
      posixShell("win32", env),
      join(dir, "Git", "usr", "bin", "sh.exe"),
    );
    assert.equal(posixShell("linux", env), "/bin/sh");
    assert.equal(
      posixShell("win32", { PATH: join(dir, "nowhere"), PATHEXT: ".EXE" }),
      undefined,
    );
  }));

test(
  "killTree ends the child and a long-lived descendant",
  {
    skip:
      process.platform !== "win32" &&
      "taskkill tree termination is Windows-only",
  },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});console.log(c.pid);setInterval(()=>{},1000)`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const grandchild = await new Promise<number>((resolve) =>
      child.stdout!.once("data", (chunk) =>
        resolve(Number(String(chunk).trim())),
      ),
    );
    const exited = new Promise((resolve) => child.once("close", resolve));
    try {
      assert.ok(alive(grandchild));
      killTree(child, "SIGTERM", "win32");
      await exited;
      for (let i = 0; i < 50 && alive(grandchild); i++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(alive(grandchild), false, "descendant is gone");
    } finally {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  },
);

test(
  "killTree ends a descendant that outlives its parent while holding the output pipe",
  {
    skip:
      process.platform !== "win32" &&
      "taskkill tree termination is Windows-only",
  },
  async () => {
    // libuv ties Node-spawned children to their parent's job object, so the descendant is detached to outlive it. The parent prints the descendant's pid and exits at once; the descendant keeps stdout open, so `close` never fires on its own.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"],detached:true});console.log(c.pid);process.exit(0)`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const grandchild = await new Promise<number>((resolve) =>
      child.stdout!.once("data", (chunk) =>
        resolve(Number(String(chunk).trim())),
      ),
    );
    await new Promise((resolve) => child.once("exit", resolve));
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      assert.ok(alive(grandchild), "descendant outlived its parent");
      killTree(child, "SIGKILL", "win32");
      await closed;
      for (let i = 0; i < 50 && alive(grandchild); i++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(alive(grandchild), false, "descendant is gone");
    } finally {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  },
);
