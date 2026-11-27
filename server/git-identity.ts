import { execFileSync } from "node:child_process";

/**
 * Config arguments to put before a `commit` or `merge` that Alice makes on the operator's behalf. Alice commits as
 * the operator: their `user.name`, `user.email` and signing settings (`commit.gpgsign`, `user.signingkey`) apply, so
 * a signed commit's author matches the key and the forge shows it as verified. Only when the repository has no
 * name or email configured does Alice fill in its own, so the commit still succeeds.
 */
export function commitIdentityArgs(repo: string): string[] {
  const configured = (key: string) => {
    try { return execFileSync("git", ["-C", repo, "config", "--get", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return ""; }
  };
  const args: string[] = [];
  if (!configured("user.name")) args.push("-c", "user.name=Alice");
  if (!configured("user.email")) args.push("-c", "user.email=alice@localhost");
  return args;
}
