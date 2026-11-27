// The version this copy of Alice reports: package.json's version plus the short Git hash when it is a checkout.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function readVersion(root = join(dirname(fileURLToPath(import.meta.url)), "..")) {
  let version = "unknown", commit = null;
  try { version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? version; } catch { /* keep unknown */ }
  try { commit = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { /* not a checkout */ }
  return { version, commit };
}

export const formatVersion = ({ version, commit }) => commit ? `${version} (${commit})` : version;
