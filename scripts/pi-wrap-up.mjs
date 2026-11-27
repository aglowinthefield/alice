// Pi extension Alice loads into every card run (`pi -e`). Pi's JSON mode takes no input once started, so Alice
// drops a message in the file named by ALICE_WRAP_UP_FILE and this extension steers the running session with it.
// It only steers while the agent is busy: a message sent to an idle session would start a new turn after the run
// settled. Claiming the file by rename means each message is delivered once.
// It also writes the session's file path to ALICE_SESSION_RECORD, so Alice knows where Pi keeps the session
// (which depends on Pi's own settings) when it decides whether the next attempt can continue it.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export default function wrapUp(pi) {
  // The BAKERY_ names are for a server started before the rename: it runs this file from the updated checkout.
  const record = process.env.ALICE_SESSION_RECORD ?? process.env.BAKERY_SESSION_RECORD;
  if (record) pi.on("session_start", (_event, ctx) => {
    try { writeFileSync(record, ctx?.sessionManager?.getSessionFile?.() ?? ""); }
    catch (error) { console.error(`Alice could not record the session file: ${error instanceof Error ? error.message : String(error)}`); }
  });
  const file = process.env.ALICE_WRAP_UP_FILE ?? process.env.BAKERY_WRAP_UP_FILE;
  if (!file) return;
  let busy = false;
  pi.on("agent_start", () => { busy = true; });
  pi.on("agent_settled", () => { busy = false; });
  const poll = setInterval(() => {
    if (!busy) return;
    const claimed = `${file}.delivered`;
    try { renameSync(file, claimed); } catch { return; }
    try { pi.sendUserMessage(readFileSync(claimed, "utf8"), { deliverAs: "steer" }); }
    catch (error) { console.error(`Alice wrap-up message was not delivered: ${error instanceof Error ? error.message : String(error)}`); }
  }, 1000);
  poll.unref?.();
  pi.on("session_shutdown", () => clearInterval(poll));
}
