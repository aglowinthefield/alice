// Pi extension Bakery loads into every card run (`pi -e`). Pi's JSON mode takes no input once started, so Bakery
// drops a message in the file named by BAKERY_WRAP_UP_FILE and this extension steers the running session with it.
// It only steers while the agent is busy: a message sent to an idle session would start a new turn after the run
// settled. Claiming the file by rename means each message is delivered once.
import { readFileSync, renameSync } from "node:fs";

export default function wrapUp(pi) {
  const file = process.env.BAKERY_WRAP_UP_FILE;
  if (!file) return;
  let busy = false;
  pi.on("agent_start", () => { busy = true; });
  pi.on("agent_settled", () => { busy = false; });
  const poll = setInterval(() => {
    if (!busy) return;
    const claimed = `${file}.delivered`;
    try { renameSync(file, claimed); } catch { return; }
    try { pi.sendUserMessage(readFileSync(claimed, "utf8"), { deliverAs: "steer" }); }
    catch (error) { console.error(`Bakery wrap-up message was not delivered: ${error instanceof Error ? error.message : String(error)}`); }
  }, 1000);
  poll.unref?.();
  pi.on("session_shutdown", () => clearInterval(poll));
}
