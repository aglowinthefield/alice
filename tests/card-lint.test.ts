import assert from "node:assert/strict";
import { test } from "node:test";
import { lintCard, readyFlags } from "../src/card-lint.js";

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

test("only Triage cards written by people are checked on the way to Ready", () => {
  const card = { title: "Polish onboarding", body: "Try it on a physical iPhone.", status: "triage" };
  assert.deepEqual(readyFlags(card).map(flag => flag.rule), ["person-only", "no-acceptance"]);
  assert.deepEqual(readyFlags({ ...card, status: "failed" }), [], "a retry was committed to before");
  assert.deepEqual(readyFlags({ ...card, status: "done" }), [], "reopening is not a first move to Ready");
  assert.deepEqual(readyFlags({ ...card, sentinelId: "sentinel-1" }), [], "sentinel cards come from Alice's own template");
});
