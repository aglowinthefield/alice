import { git } from "./git-async.js";

/**
 * Config arguments to put before a `commit` or `merge` that Bakery makes on the operator's behalf. Bakery commits as
 * the operator: their `user.name`, `user.email` and signing settings (`commit.gpgsign`, `user.signingkey`) apply, so
 * a signed commit's author matches the key and the forge shows it as verified. Only when the repository has no
 * name or email configured does Bakery fill in its own, so the commit still succeeds.
 */
export async function commitIdentityArgs(repo: string): Promise<string[]> {
  const configured = (key: string) => git(repo, ["config", "--get", key]).catch(() => "");
  const [name, email] = await Promise.all([configured("user.name"), configured("user.email")]);
  const args: string[] = [];
  if (!name) args.push("-c", "user.name=Bakery");
  if (!email) args.push("-c", "user.email=bakery@localhost");
  return args;
}
