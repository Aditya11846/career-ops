// ─────────────────────────────────────────────────────────────────────────────
// SECRET MCP SERVER — the private half of the agentic apply redesign.
//
// Spawned as its OWN node process (stdio MCP server) by live-agent.ts's
// runAgenticReach(), alongside the Playwright MCP server. It attaches to the
// SAME headed browser session.ts already opened (via CDP), so the model drives
// the live page with Playwright tools while THIS server fills secrets into the
// field the model just clicked into focus — the actual values never appear in
// the model's prompt, transcript, or tool args.
//
// Tool inventory (secrets come from env, never from tool arguments):
//   fill_focused_email / fill_focused_new_password / fill_focused_existing_password
//     → write the value into document.activeElement (native setter + events,
//       same mechanics as ats-account.ts's actuateField, inlined here because
//       this file must run standalone via `node` and can't import across the
//       Next/SWC↔node toolchain boundary).
//   check_focused_consent   → tick the focused Terms/Privacy checkbox.
//   await_verification_email → poll Gmail for the account-activation link,
//       open it, mark the credential record "verified", return "activated".
//   signal_reached_application_form / signal_blocked(reason)
//     → write the run's terminal state to SECRET_RESULT_PATH (the spawner
//       reads it after the CLI exits) — replaces the old JSON ready_to_fill /
//       blocked actions as genuine tool calls.
//
// This is a MINIMAL stdio MCP implementation (JSON-RPC 2.0, newline-delimited),
// hand-rolled so we need no @modelcontextprotocol/sdk dependency in web/.
// It must only use erasable TypeScript (Node v25 type-stripping) — no enums,
// no namespaces, no parameter properties.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";

const ENV = process.env;
const CDP = ENV.SECRET_CDP_ENDPOINT || "";
const EMAIL = ENV.SECRET_EMAIL || "";
const NEW_PASSWORD = ENV.SECRET_NEW_PASSWORD || "";
const EXISTING_PASSWORD = ENV.SECRET_EXISTING_PASSWORD || "";
const LOGIN_DOMAIN = ENV.SECRET_LOGIN_DOMAIN || "";
const RESULT_PATH = ENV.SECRET_RESULT_PATH || "";
const CREDS_PATH = ENV.SECRET_CREDS_PATH || ""; // data/ats-credentials/<slug>.json

let browser: Browser | null = null;
let currentPage: Page | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.connectOverCDP(CDP);
  // Track the foregrounded tab so "focused field" always means the page the
  // model is actually looking at (Playwright MCP works on the active page).
  // "foregrounded" is a real runtime event but isn't in playwright-core's TS
  // Page type yet — cast to the loose emitter so the cast is erasable-only.
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      (p as unknown as { on(event: string, fn: (pg: Page) => void): void }).on("foregrounded", (pg) => (currentPage = pg));
      if (p.isClosed()) continue;
      if (!currentPage || currentPage.isClosed()) currentPage = p;
    }
  }
  return browser;
}

async function activePage(): Promise<Page | null> {
  try {
    const b = await getBrowser();
    const live = b.contexts().flatMap((c) => c.pages()).filter((p) => !p.isClosed());
    if (currentPage && !currentPage.isClosed() && live.includes(currentPage)) return currentPage;
    currentPage = live[live.length - 1] || null;
    return currentPage;
  } catch {
    return null;
  }
}

type FocusInfo = { kind: string; tag: string; type: string; aria: string };

async function focusInfo(page: Page): Promise<FocusInfo> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { kind: "none", tag: "", type: "", aria: "" };
    const tag = el.tagName.toLowerCase();
    const type = ((el as HTMLInputElement).type || "").toLowerCase();
    const editable = tag === "input" || tag === "textarea" || el.isContentEditable || el.getAttribute("contenteditable") === "true";
    return { kind: editable ? "editable" : tag === "input" && type === "checkbox" ? "checkbox" : "other", tag, type, aria: el.getAttribute("aria-label") || el.getAttribute("name") || "" };
  });
}

/** Same actuation contract as ats-account.ts's actuateField, but against
 *  document.activeElement instead of a data-co-field tag. Native setter +
 *  input/change events (React/custom widgets), verify, fall back to typing. */
async function fillFocused(page: Page, value: string): Promise<{ ok: boolean; msg: string }> {
  const info = await focusInfo(page);
  if (info.kind !== "editable") {
    return { ok: false, msg: `Focused element is not an editable field (${info.kind || "nothing focused"}${info.tag ? " <" + info.tag + ">" : ""}${info.aria ? ` aria="${info.aria}"` : ""}). Click the target field with the browser tool first.` };
  }
  const landed = await page.evaluate((v) => {
    const el = document.activeElement as (HTMLInputElement | HTMLTextAreaElement) & { value?: string };
    if (!el) return false;
    const proto = Object.getPrototypeOf(el) as { [k: string]: PropertyDescriptor | undefined };
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return (el.value || "") === v;
  }, value);
  if (!landed) {
    await page.keyboard.press("Meta+A").catch(() => page.keyboard.press("Control+A")).catch(() => {});
    await page.keyboard.type(value);
    const after = await page.evaluate(() => (document.activeElement as { value?: string } | null)?.value ?? "");
    if (after !== value) return { ok: false, msg: "Focused field did not accept the value (native setter and typing both failed). It may be read-only or a custom widget — try clicking deeper into it, or pick another field." };
  }
  return { ok: true, msg: "Filled the focused field." };
}

async function checkFocusedConsent(page: Page): Promise<{ ok: boolean; msg: string }> {
  const info = await focusInfo(page);
  if (info.kind === "checkbox") {
    const checked = await page.evaluate(() => (document.activeElement as HTMLInputElement)?.checked ?? false);
    if (!checked) {
      await page.evaluate(() => {
        const el = document.activeElement as HTMLInputElement;
        el.click();
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    return { ok: true, msg: "Consent checkbox is now checked." };
  }
  return { ok: false, msg: `Focused element is not a checkbox (${info.kind || "nothing focused"}${info.tag ? " <" + info.tag + ">" : ""}). Click the consent checkbox with the browser tool first.` };
}

// ── Verification-email polling (inlined from ats-account.ts; standalone file) ──

function getMessageBody(payload: { body?: { data?: string }; parts?: unknown[] } | undefined): string {
  if (!payload) return "";
  let body = "";
  if (payload.body?.data) {
    const base64 = payload.body.data.replace(/-/g, "+").replace(/_/g, "/");
    body += Buffer.from(base64, "base64").toString("utf-8");
  }
  if (payload.parts) for (const part of payload.parts) body += getMessageBody(part as typeof payload);
  return body;
}

async function waitForActivationLink(loginDomain: string, email: string, timeoutMs: number): Promise<string | null> {
  const clientId = ENV.GMAIL_CLIENT_ID;
  const clientSecret = ENV.GMAIL_CLIENT_SECRET;
  const refreshToken = ENV.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("secret-mcp: missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN");
  const domainLabels = loginDomain.split(".");
  const accepted = [loginDomain, ...(domainLabels.length > 2 ? [domainLabels.slice(1).join(".")] : [])];
  const matches = (from: string) => accepted.some((d) => from.endsWith(`@${d}`) || from.endsWith(`.${d}`));
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!tokenRes.ok) throw new Error(`secret-mcp: Gmail token refresh failed: ${tokenRes.status}`);
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  if (!tokenData.access_token) throw new Error("secret-mcp: Gmail token refresh returned no access_token");
  const auth = { Authorization: `Bearer ${tokenData.access_token}` };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`to:${email} newer_than:1d`)}`, { headers: auth });
    const list = (await listRes.json()) as { messages?: { id: string }[] };
    for (const m of list.messages || []) {
      const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: auth });
      const msg = (await detailRes.json()) as { payload?: { headers?: { name?: string; value?: string }[] } };
      const headers = msg.payload?.headers || [];
      const authentic = headers.some((h) => h.name?.toLowerCase() === "authentication-results" && h.value && /dmarc=pass/i.test(h.value));
      if (!authentic) continue;
      const from = (headers.find((h) => h.name?.toLowerCase() === "from")?.value || "").toLowerCase();
      if (!matches(from)) continue;
      const urls = (getMessageBody(msg.payload as never) || "").match(/https?:\/\/[^\s"'<>()]+/gi) || [];
      const link = urls.map((u) => u.replace(/[.,;:!?]+$/, "").replace(/&amp;/g, "&")).find((u) => /verify|confirm|activate/i.test(u));
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

function markCredentialStatus(status: string): void {
  if (!CREDS_PATH || !existsSync(CREDS_PATH)) return;
  try {
    const creds = JSON.parse(readFileSync(CREDS_PATH, "utf8")) as { status?: string };
    creds.status = status;
    writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
  const page = await activePage();
  if (!page && name !== "signal_reached_application_form" && name !== "signal_blocked") {
    return { content: JSON.stringify({ ok: false, msg: `Could not connect to the browser at ${CDP} — is the apply session open?` }), isError: true };
  }
  switch (name) {
    case "fill_focused_email": {
      if (!EMAIL) return { content: JSON.stringify({ ok: false, msg: "No candidate email is configured — cannot fill." }), isError: true };
      const r = await fillFocused(page!, EMAIL);
      return { content: JSON.stringify({ ok: r.ok, msg: r.msg }) };
    }
    case "fill_focused_new_password": {
      if (!NEW_PASSWORD) return { content: JSON.stringify({ ok: false, msg: "No new password exists for this run yet. Use fill_focused_existing_password, or create the account via the signup flow first." }), isError: true };
      const r = await fillFocused(page!, NEW_PASSWORD);
      return { content: JSON.stringify({ ok: r.ok, msg: r.msg }) };
    }
    case "fill_focused_existing_password": {
      if (!EXISTING_PASSWORD) return { content: JSON.stringify({ ok: false, msg: "No saved password exists for this employer. Use fill_focused_new_password (account creation) or sign in with an existing credential." }), isError: true };
      const r = await fillFocused(page!, EXISTING_PASSWORD);
      return { content: JSON.stringify({ ok: r.ok, msg: r.msg }) };
    }
    case "check_focused_consent": {
      const r = await checkFocusedConsent(page!);
      return { content: JSON.stringify({ ok: r.ok, msg: r.msg }) };
    }
    case "await_verification_email": {
      const timeoutMs = Number(ENV.SECRET_EMAIL_TIMEOUT_MS || 300_000);
      const link = await waitForActivationLink(LOGIN_DOMAIN, EMAIL, timeoutMs);
      if (!link) return { content: JSON.stringify({ ok: false, msg: "No verification email arrived within the wait window. Re-check the account-creation form and try again." }), isError: true };
      await page!.goto(link, { waitUntil: "domcontentloaded" }).catch(() => {});
      markCredentialStatus("verified");
      return { content: JSON.stringify({ ok: true, msg: "activated — the verification email arrived and the activation link was opened. The page should now be signed-in; continue toward the application form." }) };
    }
    case "signal_reached_application_form": {
      writeResult({ reached: true, reason: "reached", detail: "model signalled the real application form", at: new Date().toISOString() });
      return { content: JSON.stringify({ ok: true, msg: "Run recorded as reached — the application form has been reached. End the session." }) };
    }
    case "signal_blocked": {
      const reason = typeof args.reason === "string" ? args.reason.slice(0, 500) : "unspecified";
      writeResult({ reached: false, reason: "blocked", detail: reason, at: new Date().toISOString() });
      return { content: JSON.stringify({ ok: true, msg: `Run recorded as blocked: ${reason}. End the session.` }) };
    }
    default:
      return { content: JSON.stringify({ ok: false, msg: `Unknown tool ${name}` }), isError: true };
  }
}

function writeResult(r: { reached: boolean; reason: string; detail: string; at: string }): void {
  if (!RESULT_PATH) return;
  try {
    mkdirSync(dirname(RESULT_PATH), { recursive: true });
    writeFileSync(RESULT_PATH, JSON.stringify(r), "utf8");
  } catch {
    /* best-effort */
  }
}

// ── Minimal stdio MCP transport ──────────────────────────────────────────────

const TOOLS = [
  {
    name: "fill_focused_email",
    description: "Fill the candidate's email into the currently focused field (click the field with the browser tool first). The value is never shown to you.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "fill_focused_new_password",
    description: "Fill the newly generated password for this employer into the currently focused field. Use ONLY when creating a brand-new account. The value is never shown to you.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "fill_focused_existing_password",
    description: "Fill the saved password for this employer into the currently focused field. Use when signing into an account created in a previous session. The value is never shown to you.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "check_focused_consent",
    description: "Tick the Terms/Privacy consent checkbox that is currently focused (click it with the browser tool first to focus it).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "await_verification_email",
    description: "Wait for the employer's account-activation email to arrive, open its link, and mark the account verified. Call after submitting an account-creation form. Returns 'activated' on success or an error/timeout message.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "signal_reached_application_form",
    description: "Call when the current page IS the real job application form (resume/CV upload, personal details, cover letter, etc.) — NOT a login, signup, splash, or intermediate page. Ends the run successfully.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "signal_blocked",
    description: "Call when a genuine blocker makes the application form unreachable (CAPTCHA, MFA challenge, verified dead-end). Investigate with screenshots/snapshots first — do NOT call on transient empty page states.",
    inputSchema: { type: "object", properties: { reason: { type: "string", description: "Specific reason the run is blocked" } }, required: ["reason"], additionalProperties: false },
  },
];

let writeChain: Promise<void> = Promise.resolve();
function send(obj: unknown): void {
  writeChain = writeChain.then(
    () =>
      new Promise<void>((resolve) => {
        process.stdout.write(JSON.stringify(obj) + "\n", () => resolve());
      })
  );
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (raw) => {
  let msg: { id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  void (async () => {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "career-ops-secret", version: "1.0.0" } } });
      return;
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }
    if (method === "tools/call") {
      const name = params?.name || "";
      const args = params?.arguments || {};
      try {
        const r = await callTool(name, args);
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: r.content }], isError: !!r.isError } });
      } catch (e) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ ok: false, msg: `secret-mcp: ${e instanceof Error ? e.message : String(e)}` }) }], isError: true } });
      }
      return;
    }
    // Unknown method — respond with method-not-found but don't crash.
    send({ jsonrpc: "2.0", id, result: {} });
  })();
});

// Give the host a short window to connect the browser lazily; no crash if it
// hasn't — tools return a clear "connect to the browser first" error.
process.on("unhandledRejection", () => { /* keep the server alive on transient CDP failures */ });
