// Drives the real browser client against this worktree's local development account service.
// A read-only, dev-only preflight must prove that codes are returned without sending email.
// The script creates one example.test account session, reads its empty host directory and profile,
// and signs out. It creates no host and does not change model accounts or existing workspace data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger, redactText } from "@openbot/logging";
import { chromium } from "playwright-core";
import { assertMutationAllowed } from "./dev-automation/cdp-client";
import { readDevStackRecords } from "./dev-automation/stack-registry";
import { readScriptArguments } from "./script-arguments";

const args = readScriptArguments({
  usage:
    "Usage: bun scripts/independent-web-client-e2e.ts --auth-api=http://127.0.0.1:<port> --allow-mutations [--browser-executable=<path>]",
  options: {
    "auth-api": { type: "string" },
    "allow-mutations": { type: "boolean" },
    "browser-executable": { type: "string" },
  },
});
if (!args) process.exit(0);
assert.ok(args.values["auth-api"], "Name this worktree's local development account service.");
const api = new URL(args.values["auth-api"]);
assert.ok(
  api.protocol === "http:" &&
    api.hostname === "127.0.0.1" &&
    api.port &&
    !api.username &&
    !api.password &&
    api.pathname === "/" &&
    !api.search &&
    !api.hash,
  "The check requires an explicit HTTP loopback origin with a port.",
);
const stack = readDevStackRecords().find(
  (record) =>
    resolve(record.projectRoot) === resolve(process.cwd()) &&
    record.services.includes("api") &&
    record.ports.some((port) => port.name === "api" && port.port === Number(api.port)),
);
assert.ok(stack, "Start this worktree's dev:api service first. No server is started by this check.");
assertMutationAllowed({
  command: "independent-web-client-e2e",
  allowMutations: Boolean(args.values["allow-mutations"]),
  instanceNamed: true,
  target: `api:${api.port}`,
});

const proofResponse = await fetch(new URL("/__openbot_dev_auth", api), {
  redirect: "error",
  signal: AbortSignal.timeout(10_000),
});
assert.equal(proofResponse.status, 200, "The local service must expose the dev-only no-email preflight.");
const proof = await proofResponse.json();
assert.ok(
  isDynamicRecord(proof) && proof.developmentCode === true && proof.emailDelivery === false,
  "Refusing sign-in: the running service did not prove that email delivery is disabled.",
);
assert.deepEqual(proof, { developmentCode: true, emailDelivery: false });
const writeProbe = await fetch(new URL("/__openbot_dev_auth", api), {
  method: "POST",
  redirect: "error",
  signal: AbortSignal.timeout(10_000),
});
assert.equal(writeProbe.status, 404, "The development probe must accept only GET.");

const logger = createOpenBotLogger("independent-web-client-e2e");
const output = resolve(".openbot-build/independent-web-client-e2e");
await mkdir(output, { recursive: true });
const executablePath = args.values["browser-executable"];
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: "chrome" });
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const text = translateFor("en");
const email = `independent-web-${randomUUID()}@example.test`;
const checks: string[] = ["Loopback development preflight confirms sign-in codes with no email delivery"];
const commercialRequests: string[] = [];
const externalHosts = new Set<string>();
const pageErrors: string[] = [];
let signedIn = false;
let passed = false;

// Fail closed if a page tries a network service outside this development origin.
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (["http:", "https:"].includes(url.protocol) && url.origin !== api.origin) {
    externalHosts.add(url.hostname);
    await route.abort();
    return;
  }
  await route.continue();
});
page.on("request", (request) => {
  const url = new URL(request.url());
  if (/^\/api\/browser\/v[12]\/(?:me\/(?:billing|license)|hosting|sites)(?:\/|$)/u.test(url.pathname)) {
    commercialRequests.push(`${request.method()} ${url.pathname}`);
  }
});
page.on("pageerror", (error) => pageErrors.push(redactText(error.message)));

try {
  await page.goto(`${api.origin}/app?start=license&billing=portal&hosting=checkout&hosted_server=unused&cancelled=1`);
  const emailInput = page.getByRole("textbox", { name: text("account.login.email"), exact: true });
  await emailInput.waitFor();
  const cleanUrl = new URL(page.url());
  for (const key of ["start", "billing", "hosting", "hosted_server", "cancelled"])
    assert.equal(cleanUrl.searchParams.has(key), false);
  checks.push("Old purchase and checkout-return links are consumed without opening a purchase flow");

  await emailInput.fill(email);
  await page.getByRole("button", { name: text("account.login.sendCode"), exact: true }).click();
  const codeLine = page.getByText(/^Development code: /u);
  await codeLine.waitFor();
  const code = (await codeLine.textContent())?.replace(/^Development code: /u, "").replace(/[^A-Za-z0-9]/gu, "");
  assert.ok(code && code.length === 8, "The local service returned no development code.");
  const directory = page.waitForResponse((response) =>
    /^\/api\/browser\/v2\/remote\/hosts\/?$/u.test(new URL(response.url()).pathname),
  );
  const verification = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/browser/email/verify",
  );
  await page.keyboard.type(code);
  assert.equal((await verification).status(), 200);
  signedIn = true;
  assert.equal((await directory).status(), 200);
  await page.getByRole("heading", { name: text("webClient.notice.connectComputer"), exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: text("webClient.notice.createServer"), exact: true }).count(), 0);
  checks.push("A real development sign-in loads the account's host directory without paid hosting requests");

  await page.getByRole("button", { name: text("webClient.notice.join"), exact: true }).click();
  const join = page.getByRole("dialog", { name: text("server.join.title"), exact: true });
  await join.waitFor();
  await page.keyboard.press("Escape");
  await join.waitFor({ state: "hidden" });
  checks.push("The invitation flow remains available; the check does not join or create a server");

  const sessions = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/browser/v1/me/sessions",
  );
  await page.getByRole("button", { name: text("app.rail.settings"), exact: true }).click();
  assert.equal((await sessions).status(), 200);
  await page.getByRole("tab", { name: text("settings.tab.profile.title"), exact: true }).waitFor();
  await page.getByRole("button", { name: text("settings.profile.sessions.refresh"), exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: text("account.menu.billing"), exact: true }).count(), 0);
  assert.equal(await page.getByRole("dialog", { name: text("billing.title"), exact: true }).count(), 0);
  checks.push("Profile and session controls remain available with no billing entry or billing request");
  await page.screenshot({ path: resolve(output, "profile.png") });

  const signOut = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/browser/logout");
  await page.getByRole("button", { name: text("account.menu.signOut"), exact: true }).click();
  assert.equal((await signOut).status(), 200);
  signedIn = false;
  await emailInput.waitFor();
  checks.push("Sign-out ends the real development browser session");

  assert.deepEqual(commercialRequests, []);
  assert.deepEqual([...externalHosts], []);
  assert.deepEqual(pageErrors, []);
  passed = true;
} finally {
  if (signedIn) {
    const response = await context.request
      .post(`${api.origin}/api/browser/logout`, {
        headers: { Origin: api.origin, "X-OpenBot-Browser": "1", "Content-Type": "application/json" },
        data: {},
      })
      .catch(() => null);
    signedIn = response?.ok() !== true;
  }
  await writeFile(
    resolve(output, "report.json"),
    `${JSON.stringify(
      {
        passed,
        checks,
        commercialRequests,
        externalHosts: [...externalHosts],
        pageErrors,
        sessionEnded: !signedIn,
        retainedData: "One unique example.test account; no host, model, or workspace changes",
      },
      null,
      2,
    )}\n`,
  );
  await browser.close();
}
logger.info("Independent web client checks passed.");
