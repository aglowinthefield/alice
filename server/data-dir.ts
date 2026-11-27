import { homedir } from "node:os";
import { join } from "node:path";

/** Where the board's data lives: `ALICE_DATA_DIR`, else `~/.local/share/alice`. The server and `alice doctor` share it. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ALICE_DATA_DIR || join(homedir(), ".local", "share", "alice");
}
