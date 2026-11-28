import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateWidth, isPlanningCard, lintCard, planningCard, readyFlags } from "../src/card-lint.js";

const rules = (title: string, body: string) => lintCard({ title, body }).map(flag => flag.rule);
const messages = (title: string, body: string) => lintCard({ title, body }).map(flag => flag.message);
const done = "\n\n## Acceptance\n- Tests cover the change.";

test("a card asking to verify on a physical iPhone is flagged, with the words that tripped it", () => {
  const [flag] = lintCard({ title: "Fix the share sheet", body: `The share sheet crashes on iOS 18.\n\nVerify on a physical iPhone before review.${done}` });
  assert.equal(flag.rule, "person-only");
  assert.match(flag.message, /physical device/);
  assert.equal(flag.quote, "Verify on a physical iPhone before review.");
});

test("a plain code task is not flagged", () => {
  assert.deepEqual(lintCard({ title: "Rename fooBar to fooBaz", body: `Rename \`fooBar\` to \`fooBaz\` in \`server/board.ts\` and its callers.${done}` }), []);
  assert.deepEqual(lintCard({ title: "Sort cards by priority", body: "The Ready lane should list urgent cards first, then by age. Tests cover the order." }), []);
});

test("asks only a person can meet are flagged", () => {
  const person = [
    "Test it on a real Android device.",
    "Check it on my iPhone.",
    "Needs device runs on iOS 17.",
    "Ship it to TestFlight and try it.",
    "Attach screenshots taken by hand of both themes.",
    "Manually capture screenshots of the settings page.",
    "Deploy to staging and confirm the banner shows.",
    "Verify the fix in production.",
    "Smoke test against the live site.",
    "Manually test the login flow.",
    "Someone needs to verify the email looks right.",
    "Needs sign-off from design.",
    "Run a staging smoke on iOS and Android dev builds.",
    "Get the operator's approval of the report first.",
    "Check the spacing by hand on a narrow window.",
  ];
  for (const body of person) assert.deepEqual(rules("Task", `${body}${done}`), ["person-only"], body);
});

test("each kind of ask is flagged once, and the title counts too", () => {
  assert.deepEqual(messages("Verify on a physical iPhone", `Also check it on a real iPad, then deploy to staging.${done}`), [
    "Needs a physical device, which the agent does not have",
    "Needs staging or production, which the agent cannot reach",
  ]);
});

test("asks that are negated, inside code blocks, or only look alike are not flagged", () => {
  const fine = [
    "No device runs needed; the simulator test is enough.",
    "Do not deploy to staging.",
    "Fix it without a physical device: the unit tests reproduce it.",
    "Build the production bundle and check its size.",
    "Run the tests in production mode as well.",
    "Attach a Playwright screenshot of the dialog.",
    "Fix the physical layout of the sidebar.",
    "Show a device picker in settings.",
    "The list in `package.json` was written by hand; generate it instead.",
    "Run the backfill as a dry run against a prod fork.",
    "```sh\nDEPLOY_TARGET=staging npm run deploy -- --to staging\n```",
  ];
  for (const body of fine) assert.deepEqual(rules("Task", `${body}${done}`), [], body);
});

test("a card that never says what done looks like is flagged", () => {
  assert.deepEqual(rules("Fix the flaky test", ""), ["no-acceptance"]);
  assert.match(messages("Fix the flaky test", "  ")[0], /no description/);
  assert.deepEqual(rules("Clean up the sidebar", "It looks messy. Tidy it up."), ["no-acceptance"]);
  assert.match(messages("Clean up the sidebar", "It looks messy.")[0], /Acceptance heading/);
  // The title alone does not count as criteria.
  assert.deepEqual(rules("Tests should pass", "Fix the import."), ["no-acceptance"]);
});

test("acceptance criteria count in any common shape", () => {
  const shapes = [
    "Do the thing.\n\n## Acceptance\n- It works.",
    "Do the thing.\n\n**Done when** the lane shows the count.",
    "Do the thing.\n\nAcceptance criteria: the count updates live.",
    "Do the thing.\n\n- [ ] The count updates\n- [ ] The badge hides at zero",
    "Do the thing.\n\nTests: one for the empty lane.",
    "Do the thing.\n\nGiven an empty lane, when a card arrives, then the badge shows 1.",
    "The badge must hide at zero.",
    "Expected behaviour: the badge hides at zero.",
    "## Criteria\n- AC1: the badge hides at zero.",
    "Do the thing.\n\n- AC1: the badge hides at zero.",
  ];
  for (const body of shapes) assert.deepEqual(rules("Badge count", body), [], body);
});

test("both rules can flag the same card", () => {
  assert.deepEqual(rules("Polish onboarding", "Try it on a physical iPhone."), ["person-only", "no-acceptance"]);
});

test("only Triage cards are checked on the way to Ready", () => {
  const card = { title: "Polish onboarding", body: "Try it on a physical iPhone.", status: "triage" };
  assert.deepEqual(readyFlags(card).map(flag => flag.rule), ["person-only", "no-acceptance"]);
  assert.deepEqual(readyFlags({ ...card, status: "failed" }), [], "a retry was committed to before");
  assert.deepEqual(readyFlags({ ...card, status: "done" }), [], "reopening is not a first move to Ready");
});

const tenRoutes = ["/settings", "/settings/profile", "/settings/billing", "/settings/team", "/settings/keys", "/boards/:id",
  "/boards/:id/cards", "/statistics", "/logs", "/today"];

test("a card listing 10 routes is wide, and the flag says why", () => {
  const card = { title: "Move the settings routes to the file router", body: `Move these routes:\n${tenRoutes.map(route => `- \`${route}\``).join("\n")}${done}` };
  const width = estimateWidth(card);
  assert.equal(width.routes, 10);
  assert.equal(width.wide, true);
  assert.deepEqual(width.reasons, ["10 routes"], "the list of routes is not counted a second time as items");
  const [flag] = lintCard(card);
  assert.equal(flag.rule, "wide");
  assert.match(flag.message, /too wide for one run \(10 routes\).*turning it into a plan/);
});

test("a one-file fix is not wide", () => {
  const fix = { title: "Fix the off-by-one in the pager", body: "`src/pager.ts` skips the last page. Fix the bound.\n\n## Acceptance\n- A test covers the last page.\n- All tests pass." };
  assert.equal(estimateWidth(fix).wide, false);
  assert.equal(estimateWidth(fix).files, 1);
  assert.deepEqual(lintCard(fix), []);
});

test("routes skip file system paths, full URLs and slashes between words", () => {
  const width = estimateWidth({ title: "Links", body: "See https://example.com/a/b and /home/me/repo, /tmp/x.log, and/or 1/2 of `/api/boards` and `/api/boards/`." });
  assert.equal(width.routes, 1);
});

test("files count distinct paths, not library names", () => {
  const width = estimateWidth({ title: "Files", body: "Edit `src/a.ts`, `src/a.ts`, `server/b.ts`, `package.json` and README.md. Built on Node.js and Next.js." });
  assert.equal(width.files, 4);
});

test("sweeping a whole kind of thing with a migration verb is wide on its own", () => {
  for (const title of ["Migrate the remaining pages to Tailwind", "Convert every route to the new loader", "Port all of the remaining endpoints to oRPC", "Replace the old toast across the whole codebase"]) {
    const width = estimateWidth({ title, body: "Done when nothing uses the old one." });
    assert.equal(width.wide, true, title);
    assert.equal(width.sweep?.strong, true, title);
  }
});

test("a sweep alone without a migration verb, in acceptance, or negated is not enough", () => {
  assert.equal(estimateWidth({ title: "Rename fooBar", body: "Rename `fooBar` to `fooBaz` in `server/board.ts` and all its callers.\n\nTests cover it." }).wide, false);
  const acceptanceOnly = estimateWidth({ title: "Fix the route guard", body: "The guard in `src/route.ts` lets signed-out users through.\n\n## Acceptance\n- Every route redirects signed-out users." });
  assert.equal(acceptanceOnly.sweep, null, "acceptance says what done looks like, not the scope");
  assert.equal(estimateWidth({ title: "Fix the settings page", body: "Do not migrate the remaining pages; only settings.\n\nTests cover it." }).wide, false);
});

test("a feature across five surfaces is wide; four alone, or a surface named in a file path, is not", () => {
  const width = estimateWidth({ title: "Add a pickup limit", body: "Add the limit to the web board, the CLI, the TUI, the desktop app and the server API.\n\nTests cover each." });
  assert.deepEqual(width.surfaces, ["web", "CLI", "TUI", "server", "desktop"]);
  assert.equal(width.wide, true);
  assert.equal(estimateWidth({ title: "Add a pickup limit", body: "Add the limit to the web board, the CLI, the TUI and the server API.\n\nTests cover each." }).wide, false);
  assert.deepEqual(estimateWidth({ title: "Fix it", body: "Edit `server/board.ts`." }).surfaces, []);
});

test("two weaker signs together are wide; one alone is not", () => {
  const files = Array.from({ length: 8 }, (_, index) => `\`src/part${index}.ts\``).join(", ");
  assert.equal(estimateWidth({ title: "Tidy", body: `Tidy ${files}.\n\nTests cover it.` }).wide, false, "naming files is a careful brief, not width");
  assert.equal(estimateWidth({ title: "Tidy", body: `Tidy ${files} and all their callers.\n\nTests cover it.` }).wide, true);
  assert.equal(estimateWidth({ title: "Wire it up", body: "Touch `/a`, `/b` and `/c` on the web, CLI, TUI and server sides.\n\nTests cover it." }).wide, true);
});

test("a long list of things to change is wide, but a long acceptance list is not", () => {
  const items = Array.from({ length: 12 }, (_, index) => `- Page ${index}`).join("\n");
  assert.equal(estimateWidth({ title: "Restyle pages", body: `Restyle:\n${items}\n\nTests cover it.` }).listItems, 12);
  assert.equal(estimateWidth({ title: "Restyle pages", body: `Restyle:\n${items}\n\nTests cover it.` }).wide, true);
  assert.equal(estimateWidth({ title: "Restyle the header", body: `Restyle the header.\n\n## Acceptance\n${items}` }).wide, false);
});

test("cards that already ask for a plan are never wide", () => {
  const wide = { title: "Migrate the remaining pages to Tailwind", body: "Done when no CSS modules remain." };
  const plan = planningCard(wide);
  assert.equal(plan.title, "Plan: Migrate the remaining pages to Tailwind");
  assert.match(plan.body, /^Plan this work; do not implement it\..*alice-plan block\.\n\n## The work to plan\n\nDone when no CSS modules remain\.$/s);
  assert.equal(isPlanningCard(plan), true);
  assert.equal(estimateWidth(plan).wide, false);
  assert.deepEqual(planningCard(plan), { title: plan.title, body: planningCard({ title: plan.title, body: plan.body }).body }, "the title is not prefixed twice");
  assert.equal(planningCard({ title: "x".repeat(200), body: "" }).title.length, 200, "the title stays within the server's limit");
  assert.equal(isPlanningCard({ title: "Plan the auth refactor", body: "" }), true);
  assert.equal(isPlanningCard({ title: "Fix the planner", body: "" }), false);
});

test("Alice's own wide card text is not flagged, and a wide card in Triage is flagged on the way to Ready", () => {
  const own = "## Steps\n- Extend the Ready lint with a width estimate from the card text (many routes, files or surfaces, or words like \"all\", \"every\", \"migrate the remaining\").\n- For a wide card, offer \"Turn into a plan\".\n\n## Acceptance\n- A card listing 10 routes is flagged; a one-file fix is not flagged.\n- Tests cover the estimate.";
  assert.equal(estimateWidth({ title: "Warn about wide cards at Ready", body: own }).wide, false);
  assert.deepEqual(readyFlags({ title: "Migrate the remaining pages", body: `Move them.${done}`, status: "triage" }).map(flag => flag.rule), ["wide"]);
});
