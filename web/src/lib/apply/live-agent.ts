import type { Frame, Page } from "playwright-core";
import { existsSync, mkdirSync, appendFileSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot } from "@/lib/career-ops";
import { runPlanner } from "./agent-interpret";
import { getCdpPort } from "./session";
import { dropNewTabs } from "./diagnose";
import { getCredentials, initCredentials, markStatus } from "./ats-credentials";
import {
  logAccountStep,
  employerFromPage,
  actuateField,
  waitForVerificationEmail,
  loadCandidateEmail,
  attemptFastLogin,
  CONFIRM_PASSWORD_PATTERN,
} from "./ats-account";
import type { ApplyField } from "./extract";
import type { DriveStep } from "./issue";

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL LIVE-AGENT APPLY FALLBACK — replaces the fixed-branch classifier
// this codebase kept guessing wrong with (title wording, "confirm password"
// labels — real Workday tenants don't reliably use either). Instead of a
// script deciding in advance what a login-wall page must mean, this is a
// real OBSERVE → DECIDE → ACT loop: capture the actual controls on the
// actual page, ask the model for exactly ONE next action, execute it,
// re-observe, repeat — bounded so a confused loop fails loudly instead of
// running forever. Not tied to Workday or any ATS: the trigger in
// session.ts is "this page needs navigating/authenticating through," not
// "this page is Workday."
//
// Every step is streamed live to the UI via the SAME emit/DriveStep
// mechanism drive.ts already uses (wired through /api/apply/drive) — so
// what the agent is doing, and why, is visible on the website in real
// time, not just in data/ats-account-log.jsonl after the fact.
//
// Secrets never enter the prompt: the model is told WHETHER an email/
// password/existing-credential is available, never the values. Password
// generation and storage stay in ats-credentials.ts, called by this loop,
// not authored by the LLM.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_STEPS = 45;

export type LiveAgentResult = { reached: boolean; turns: number; reason: string };

type Cand = { n: number; tag: string; type: string; name: string; placeholder: string; aria: string; req: boolean; ctx: string; opts: string[] };

type Action =
  | { action: "click"; candN: number }
  | { action: "fill_email"; candN: number }
  | { action: "fill_new_password"; candN: number }
  | { action: "fill_existing_password"; candN: number }
  | { action: "fill_text"; candN: number; value: string }
  | { action: "check_consent"; candN: number }
  | { action: "wait_for_email" }
  | { action: "wait_for_page" }
  | { action: "ready_to_fill" }
  | { action: "blocked"; reason: string };

/** Unlike agent-interpret.ts's captureCandidates() — built for reading a
 *  form you're already on — this ALSO captures buttons and links, because
 *  this loop frequently starts on a page with nothing but an "Apply" or
 *  "Sign In" button and no form fields yet. Without this, the model
 *  correctly (but uselessly) reports "nothing to act on." */
async function captureLiveCandidates(frame: Frame): Promise<Cand[]> {
  return frame.evaluate(() => {
    const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim().slice(0, 220);
    const cands: Cand[] = [];
    const seenRadio = new Set<string>();
    const sel = 'input, textarea, select, button, a, [role="combobox"], [role="radiogroup"], [role="button"], [role="link"], [contenteditable="true"]';
    const els = Array.from(document.querySelectorAll(sel));
    let n = 0;
    for (const el of els) {
      const tag = el.tagName.toLowerCase();
      const itype = ((el as HTMLInputElement).type || "").toLowerCase();
      const role = el.getAttribute("role") || "";
      if (tag === "input" && ["hidden"].includes(itype)) continue;
      if ((el as HTMLElement).offsetParent === null && itype !== "radio" && itype !== "checkbox") continue;
      if ((el as Element).closest('[class*="autofill" i]')) continue;

      const cont = el.closest('[class*="field" i], [class*="question" i], fieldset, .form-group, div');
      const ctx = clean((el as HTMLElement).innerText || (cont as HTMLElement | null)?.innerText);
      const req = (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true" || /\*|\brequired\b/i.test(ctx);
      const name = (el as HTMLInputElement).name || (el as HTMLElement).id || "";
      const aria = el.getAttribute("aria-label") || "";
      const placeholder = (el as HTMLInputElement).placeholder || "";

      if (itype === "radio") {
        const rname = (el as HTMLInputElement).name;
        if (rname && seenRadio.has(rname)) continue;
        if (rname) seenRadio.add(rname);
        const group = Array.from(document.querySelectorAll(`input[type=radio][name="${CSS.escape(rname)}"]`));
        const opts = group.map((r) => clean(document.querySelector(`label[for="${CSS.escape((r as HTMLElement).id)}"]`)?.textContent || r.closest("label")?.textContent || (r as HTMLInputElement).value)).filter(Boolean);
        group.forEach((r) => r.setAttribute("data-co-cand", String(n)));
        cands.push({ n, tag: "radiogroup", type: "radio", name: rname || "", placeholder, aria, req, ctx, opts });
        n++;
        continue;
      }
      el.setAttribute("data-co-cand", String(n));
      let opts: string[] = [];
      if (tag === "select") opts = Array.from((el as HTMLSelectElement).options).map((o) => clean(o.textContent)).filter((o) => o && !/^(select|choose|--)/i.test(o));
      const kind = tag === "input" ? itype || "text" : tag === "a" ? "link" : tag === "button" || role === "button" ? "button" : itype || role || tag;
      cands.push({ n, tag, type: kind, name, placeholder, aria, req, ctx, opts });
      n++;
    }
    return cands;
  });
}

type CredState = "none" | "just-created" | "active";

function buildDecidePrompt(company: string, role: string, cands: Cand[], hasEmail: boolean, credState: CredState, history: string[]): string {
  const lines = cands
    .map((c) => `[${c.n}] tag=${c.tag} type=${c.type}${c.req ? " required" : ""}${c.name ? ` name="${c.name}"` : ""}${c.placeholder ? ` placeholder="${c.placeholder}"` : ""}${c.aria ? ` aria="${c.aria}"` : ""}${c.opts.length ? ` options=[${c.opts.slice(0, 12).join(" | ")}]` : ""} | context: "${c.ctx}"`)
    .join("\n");

  const credSituation =
    credState === "active"
      ? `You have a confirmed working account for this employer (email + password saved from a previous session). If the page asks you to sign in, do it — use fill_email then fill_existing_password then click the sign-in button.`
      : credState === "just-created"
      ? `You just created a new account for this employer during this session (you filled the email, generated a password, and submitted the registration form). The page may now be showing a sign-in form — that is the expected next step. Sign in using the same email (fill_email) and the password you just created (fill_existing_password), then click the sign-in button. Do NOT try to create another account.`
      : `No account exists yet for this employer. If the page shows a sign-in wall, look for a "Create Account", "Sign Up", or "Register" link/button and click it — do not fill a sign-in form you have no credentials for.`;

  return `You are driving a real browser toward one goal: reach and fill out the job application form for "${role}" at "${company}". Some employer sites require signing in or creating an account first.

Facts (values are never shown — reference by name only):
- candidate email: ${hasEmail ? "available" : "NOT available — cannot proceed with account creation or login"}
- credential situation: ${credSituation}

CONTROLS ON THE CURRENT PAGE:
${lines || "(no interactive controls found)"}

Decide EXACTLY ONE next action. Return ONLY a JSON object, no prose, no code fence, one of:
{"action":"click","candN":<n>}
{"action":"fill_email","candN":<n>}
{"action":"fill_new_password","candN":<n>}           // only when creating a NEW account for the first time
{"action":"fill_existing_password","candN":<n>}       // when you have credentials (active OR just-created) and need to sign in
{"action":"fill_text","candN":<n>,"value":"<text>"}   // any other benign text field (e.g. a name field some signups ask for)
{"action":"check_consent","candN":<n>}                 // a Terms/Privacy consent checkbox blocking signup
{"action":"wait_for_email"}                             // you just submitted a signup form and expect a verification email
{"action":"wait_for_page"}                               // a button looks disabled — pause 3s for async validation before retrying
{"action":"ready_to_fill"}                               // this page IS the actual job application form (resume, name, cover letter fields) — stop here
{"action":"blocked","reason":"<why>"}                    // a real CAPTCHA, MFA challenge, or genuinely no way forward

Steps taken so far this run:
${history.length ? history.join("\n") : "(none yet)"}`;
}

async function decide(cliId: string, prompt: string): Promise<Action | null> {
  const resolved = resolveCli(cliId);
  if (!resolved) return null;
  const out = await runPlanner(resolved.binPath, cliId === "claude", resolved.spec.args, prompt);
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Action;
  } catch {
    return null;
  }
}

async function richestFrame(page: Page): Promise<Frame> {
  let best = page.mainFrame();
  let bestN = -1;
  for (const fr of page.frames()) {
    const n = await fr.evaluate(() => document.querySelectorAll('input, textarea, select, button, a, [role="combobox"], [contenteditable="true"]').length).catch(() => 0);
    if (n > bestN) {
      bestN = n;
      best = fr;
    }
  }
  return best;
}

/** True once the current controls look like the REAL application form,
 *  not a login/signup/intermediate page — mirrors session.ts's
 *  looksLikeApplicationForm() heuristic at the candidate level so the
 *  model's own "ready_to_fill" call can be sanity-checked.
 *
 *  Name fields alone are NOT sufficient evidence: most ATS signup/account
 *  pages (Ashby, Lever, many Workday tenants) also ask for first/last name,
 *  so a name-only check fires on step 1 of account creation and reports the
 *  application as "reached" before an account even exists (#bug_022). Only
 *  a signal unique to application forms (resume/CV upload, cover letter,
 *  "why this role"), or a name field paired with another application-only
 *  field, counts. */
function candsLookLikeApplication(cands: Cand[]): boolean {
  const text = (c: Cand) => c.ctx || c.aria || c.placeholder || "";
  // Only INPUT-like elements count as unique signals — a <button>Autofill with Resume</button>
  // on a Workday splash page must NOT fire this, or the agent exits at step 0 before clicking
  // "Apply Manually" / "Apply" and never runs a single LLM decision (#bug_workday_splash).
  const isField = (c: Cand) => !["button", "a"].includes(c.tag);
  const hasUniqueAppSignal = cands.some((c) => isField(c) && /resume|résumé|\bcv\b|cover letter|why (this|you|are)/i.test(text(c)));
  if (hasUniqueAppSignal) return true;
  const hasName = cands.some((c) => /first name|last name|full name/i.test(text(c)));
  const hasOtherAppField = cands.some((c) => /phone|linkedin|github|portfolio|sponsorship|relocat/i.test(text(c)));
  return hasName && hasOtherAppField;
}

function candToField(c: Cand): ApplyField {
  return { id: `la${c.n}`, type: (["text", "email", "tel", "url", "number", "date", "textarea", "select", "radio", "checkbox", "file"].includes(c.type) ? c.type : "text") as ApplyField["type"], label: c.ctx || c.aria || c.placeholder || "", required: c.req, options: c.opts.length ? c.opts : undefined, combobox: c.tag !== "select" && c.type === "select" };
}

async function shot(page: Page): Promise<string | undefined> {
  try {
    return `data:image/jpeg;base64,${(await page.screenshot({ type: "jpeg", quality: 38 })).toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** Main entry point. Streams every decision live via `emit` (rendered by
 *  the SAME UI drive.ts's exploration loop already streams to). Returns
 *  `reached: true` once the page is ready for the caller's normal
 *  extractForm()/pickFormFrame() pass to take over (the REAL application
 *  form). `reached: false` on a genuine blocker or an exhausted step
 *  budget — caller should fall through to its existing blocking-issue
 *  handling either way (this never attempts to defeat a real CAPTCHA). */
/** Every emitted step also gets appended here — the DrivePanel only shows the
 *  live sequence to whoever is watching at the time; this is what lets a run
 *  be diagnosed afterward without needing someone to describe what they saw. */
const TRACE_PATH = "data/ats-agent-trace.jsonl";

function traceStep(runId: string, s: DriveStep & { rawDecision?: unknown }): void {
  const p = join(careerOpsRoot(), TRACE_PATH);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(p, JSON.stringify({ runId, timestamp: new Date().toISOString(), ...s }) + "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENTIC PATH (claude only) — one genuine multi-turn session per apply attempt.
//
// The hybrid loop above re-invokes a stateless CLI once per step with a CLOSED
// action enum plus our own DOM-candidate list; that's what failed on real
// Workday tenants (the candidate list comes back empty mid-render and the model
// has to guess what page it's on from the enum). Here the model holds a real
// tool loop: Playwright MCP attached to the very page session.ts already opened
// (via its remote-debugging-port), giving it browser_snapshot/click/type/wait/
// screenshot, plus a private secret MCP server that writes email/password into
// the focused field — the values never enter the model's prompt or transcript.
// No static heuristic decides what a page "is"; the model decides from what it
// actually observes.
// ─────────────────────────────────────────────────────────────────────────────

const AGENTIC_MAX_TURNS = 60;

type AgenticCtx = {
  page: Page;
  url: string;
  title: string;
  employer: string;
  slug: string;
  loginDomain: string;
  email: string;
  role: string;
  runId: string;
  emit: (s: DriveStep & { rawDecision?: unknown }) => void;
};

/** The whole decision lives in prose — no fixed action enum. The model is told
 *  the one invariant (secrets come only via the secret tools) and otherwise
 *  free to read the page, click around, and decide what to do, exactly like a
 *  person. */
function buildAgenticPrompt(ctx: AgenticCtx, credState: CredState): string {
  const secrets =
    credState === "active"
      ? "You have a confirmed working account for this employer (email + saved password). If the page asks you to sign in, click the email field → fill_focused_email, click the password field → fill_focused_existing_password, then click the sign-in button. Do NOT create another account."
      : credState === "just-created"
      ? "A password was already generated for this employer (an earlier attempt may be mid-flight). If the page is a signup/registration form, keep filling it — click each field, then fill_focused_email / fill_focused_new_password. If the page instead shows a sign-in form, sign in with fill_focused_existing_password. Never create two accounts."
      : "No account exists yet for this employer. If the page shows a sign-in wall, find and click a 'Create Account' / 'Sign Up' / 'Register' link. When creating an account, fill the email with fill_focused_email and the password with fill_focused_new_password (a password is ready for you — never type one yourself).";

  return `You are driving a real browser toward ONE goal: reach the real job application form for "${ctx.role}" at ${ctx.employer}. (You started at: ${ctx.url})

How to work:
1. Start with browser_snapshot to see the page. Use browser_click, browser_type, browser_navigate, browser_wait_for, and browser_take_screenshot to move around and investigate. The form may live in an iframe — check across frames if a page looks empty.
2. Many employer sites gate the application form behind sign-in or account creation. Decide ON THE SPOT what the page requires — there are no fixed rules.
3. To fill a field: click it first with a browser tool (that focuses it), THEN call the matching secret tool — it writes the value into the focused field. Never type email/password values yourself.
4. ${secrets}
5. After submitting an account-creation form that triggers an activation email, call await_verification_email — it waits for the email, opens its activation link, and returns "activated".
6. The goal is REACHED only when the page is the actual job application form (resume/CV upload, personal details, cover letter, 'why this role' — NOT a login, signup, splash, or intermediate page). Then call signal_reached_application_form and stop.
7. If you hit a genuine blocker (CAPTCHA, MFA, verified dead-end), call signal_blocked with a specific reason and stop. Do NOT call it just because a snapshot looks momentarily empty — wait for render (browser_wait_for) and screenshot to investigate first.`;
}

/** Writes the temp --mcp-config JSON declaring EXACTLY the two servers this
 *  run needs (paired with --strict-mcp-config so no user/project MCP servers
 *  leak in). Returns the path; caller unlinks it in a finally. */
function writeAgenticMcpConfig(o: { runId: string; cdpEndpoint: string; email: string; newPassword: string | null; existingPassword: string | null; loginDomain: string; slug: string }): string {
  const secretEntry = join(careerOpsRoot(), "web", "src", "lib", "apply", "secret-mcp-server.ts");
  const config = {
    mcpServers: {
      playwright: {
        type: "stdio",
        command: "npx",
        args: ["--yes", "@playwright/mcp@latest", "--cdp-endpoint", o.cdpEndpoint],
      },
      secret: {
        type: "stdio",
        command: "node",
        args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", secretEntry],
        env: {
          SECRET_CDP_ENDPOINT: o.cdpEndpoint,
          SECRET_EMAIL: o.email,
          SECRET_NEW_PASSWORD: o.newPassword || "",
          SECRET_EXISTING_PASSWORD: o.existingPassword || "",
          SECRET_LOGIN_DOMAIN: o.loginDomain,
          SECRET_RESULT_PATH: join(careerOpsRoot(), "data", `ats-agent-result-${o.runId}.json`),
          SECRET_CREDS_PATH: join(careerOpsRoot(), "data", "ats-credentials", `${o.slug}.json`),
        },
      },
    },
  };
  const path = join(careerOpsRoot(), "data", `ats-mcp-${o.runId}.json`);
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
  return path;
}

function readAgentSignal(runId: string): { reached: boolean; reason: string; detail: string } | null {
  const p = join(careerOpsRoot(), "data", `ats-agent-result-${runId}.json`);
  try {
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as { reached: boolean; reason: string; detail: string };
  } catch {
    return null;
  }
}

/** Main agentic entry: spawn one claude session wired to Playwright MCP (CDP)
 *  + the secret server, wait for the terminal signal file, promote creds on
 *  success, and always clean up the temp config (it embeds secrets). */
async function runAgenticReach(ctx: AgenticCtx): Promise<LiveAgentResult> {
  const { page, url, employer, slug, loginDomain, email, role, runId, emit } = ctx;

  // Pre-stage the credential state + passwords BEFORE spawning so the model's
  // secret tools have values the moment it calls them. Idempotent: a partial
  // prior attempt's record is reused (same password) instead of fragmented.
  let creds = getCredentials(slug);
  let credState: CredState;
  let newPassword: string | null = null;
  let existingPassword: string | null = null;
  if (creds?.status === "active") {
    credState = "active";
    existingPassword = creds.password;
  } else {
    if (!creds) creds = initCredentials(slug, employer, loginDomain, email);
    newPassword = creds.password;
    credState = creds.status === "verified" ? "just-created" : "none";
  }

  const port = await getCdpPort();
  const cdpEndpoint = `http://127.0.0.1:${port}`;
  const mcpConfigPath = writeAgenticMcpConfig({ runId, cdpEndpoint, email, newPassword, existingPassword, loginDomain, slug });
  const resultPath = join(careerOpsRoot(), "data", `ats-agent-result-${runId}.json`);

  try {
    emit({ turn: 0, action: "start", detail: `Starting a genuine agentic session — the model now drives the live browser directly (${role} @ ${employer}) with real snapshots and tools, up to ${AGENTIC_MAX_TURNS} turns.` });

    const resolved = resolveCli("claude");
    if (!resolved) {
      emit({ turn: 0, action: "stuck", detail: "Claude CLI not found — the agentic apply path requires it." });
      return { reached: false, turns: 0, reason: "no-claude" };
    }

    const out = await runPlanner(resolved.binPath, true, resolved.spec.args, buildAgenticPrompt(ctx, credState), {
      mcpConfigPath,
      outputFormat: "json",
      maxTurns: AGENTIC_MAX_TURNS,
    });

    // Best-effort turn count from the CLI's JSON result (e.g. 30 → report it);
    // fall back to 1 so the UI still shows "1 step" for a clean session.
    const turnsMatch = /"total_turns"\s*:\s*(\d+)/.exec(out);
    const turns = turnsMatch ? Number(turnsMatch[1]) : 1;

    const sig = readAgentSignal(runId);
    if (sig?.reached) {
      if (creds.status !== "active") markStatus(slug, "active"); // just-created → reusable via fast-login next time
      logAccountStep({ employer, employerSlug: slug, email, step: "application_filled", detail: `agentic session reached the application form (${turns} turns)` });
      emit({ turn: turns, action: "reached", detail: sig.detail || "The model reached the real application form.", thumb: await shot(page) });
      return { reached: true, turns, reason: "reached" };
    }
    if (sig) {
      logAccountStep({ employer, employerSlug: slug, email, step: "failed", detail: `blocked: ${sig.detail}` });
      emit({ turn: turns, action: "blocked", detail: sig.detail, thumb: await shot(page) });
      return { reached: false, turns, reason: "blocked" };
    }
    const detail = "The agentic session ended without reaching the application form or reporting a blocker (turn budget exhausted, a parse failure, or an early exit).";
    logAccountStep({ employer, employerSlug: slug, email, step: "failed", detail });
    emit({ turn: turns, action: "stuck", detail, thumb: await shot(page) });
    return { reached: false, turns, reason: "no-result" };
  } finally {
    // The temp config embeds secrets — always remove it and any leftover signal.
    for (const p of [mcpConfigPath, resultPath]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

export async function runLiveAgent(page: Page, frame: Frame, url: string, title: string, cliId: string, emit: (s: DriveStep) => void): Promise<LiveAgentResult> {
  const { employer, slug, loginDomain } = employerFromPage(url, title);
  const email = loadCandidateEmail();
  const role = title || "the role";
  const runId = `${slug}-${Date.now()}`;
  const emitAndTrace = (s: DriveStep & { rawDecision?: unknown }) => {
    traceStep(runId, s);
    emit(s);
  };

  if (!email) {
    logAccountStep({ employer, employerSlug: slug, email: "unknown", step: "failed", detail: "no candidate email in profile" });
    emitAndTrace({ turn: 0, action: "blocked", detail: "No candidate email found in config/profile.yml — can't create or log into an account." });
    return { reached: false, turns: 0, reason: "no-email" };
  }

  let creds = getCredentials(slug);
  if (creds?.status === "active") {
    emitAndTrace({ turn: 0, action: "fast-login", detail: `Already have a working account for ${employer} — logging in directly, no exploration needed.` });
    const ok = await attemptFastLogin(page, frame, creds, cliId, employer, slug);
    return { reached: ok, turns: 1, reason: ok ? "fast-login" : "fast-login-failed" };
  }

  // claude gets the genuine agentic path (one multi-turn MCP tool session over
  // CDP — the redesign). Other CLIs keep the hybrid loop below: codex/gemini
  // have no confirmed non-interactive MCP tool-loop story yet, and a clean
  // result either way beats a silent failure.
  if (cliId === "claude") {
    return runAgenticReach({ page, url, title, employer, slug, loginDomain, email, role, runId, emit: emitAndTrace });
  }

  let curFrame = frame;
  const history: string[] = [];
  let newPassword: string | null = null;
  let lastActionKey: string | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const cands = await captureLiveCandidates(curFrame).catch(() => [] as Cand[]);

    if (candsLookLikeApplication(cands)) {
      // If we just signed in with freshly created creds, promote to "active"
      // so the next run uses fast-login instead of re-creating the account.
      if (newPassword !== null && creds && creds.status !== "active") markStatus(slug, "active");
      logAccountStep({ employer, employerSlug: slug, email, step: "application_filled", detail: `reached application form after ${step} step(s)` });
      emitAndTrace({ turn: step, action: "reached", detail: `Reached the real application form after ${step} step(s).`, thumb: await shot(page) });
      return { reached: true, turns: step, reason: "reached" };
    }

    const credState: CredState = creds?.status === "active" ? "active" : newPassword !== null ? "just-created" : "none";
    const prompt = buildDecidePrompt(employer, role, cands, true, credState, history);
    const act = await decide(cliId, prompt);
    traceStep(runId, { turn: step, action: "decision", detail: JSON.stringify(act), rawDecision: act });
    if (!act) {
      const detail = `Step ${step}: got no usable decision from the model — stopping.`;
      logAccountStep({ employer, employerSlug: slug, email, step: "failed", detail });
      emitAndTrace({ turn: step, action: "stuck", detail, thumb: await shot(page) });
      return { reached: false, turns: step, reason: "no-decision" };
    }

    if (act.action === "blocked") {
      logAccountStep({ employer, employerSlug: slug, email, step: "failed", detail: `blocked: ${act.reason}` });
      emitAndTrace({ turn: step, action: "blocked", detail: act.reason, thumb: await shot(page) });
      return { reached: false, turns: step, reason: "blocked" };
    }

    if (act.action === "ready_to_fill") {
      logAccountStep({ employer, employerSlug: slug, email, step: "application_filled", detail: `model signalled ready after ${step} step(s)` });
      emitAndTrace({ turn: step, action: "reached", detail: "The model says this is now the real application form.", thumb: await shot(page) });
      return { reached: true, turns: step, reason: "reached" };
    }

    if (act.action === "wait_for_email") {
      history.push(`step ${step}: waited for verification email`);
      emitAndTrace({ turn: step, action: "wait_for_email", detail: `Submitted account creation — waiting for a verification email from ${loginDomain} (up to 5 minutes)...` });
      const link = await waitForVerificationEmail(loginDomain, email, 5 * 60_000);
      if (!link) {
        const detail = "No verification email arrived within 5 minutes.";
        logAccountStep({ employer, employerSlug: slug, email, step: "failed", detail });
        emitAndTrace({ turn: step, action: "stuck", detail });
        return { reached: false, turns: step, reason: "no-verification-email" };
      }
      logAccountStep({ employer, employerSlug: slug, email, step: "verification_email_received" });
      emitAndTrace({ turn: step, action: "verified", detail: "Verification email arrived — opening the activation link." });
      await page.goto(link, { waitUntil: "domcontentloaded" }).catch(() => {});
      await dropNewTabs(page);
      markStatus(slug, "verified");
      logAccountStep({ employer, employerSlug: slug, email, step: "account_activated" });
      curFrame = await richestFrame(page);
      continue;
    }

    // wait_for_page needs no target element — handle it before the candN guard.
    if (act.action === "wait_for_page") {
      history.push(`step ${step}: waited 3s for async validation`);
      emitAndTrace({ turn: step, action: "wait_for_page", detail: "Waiting 3 s for page async validation (e.g. server-side email check before button enables)…" });
      await page.waitForTimeout(3000);
      curFrame = await richestFrame(page);
      continue;
    }

    // All other actions target a candidate by index.
    const cand = cands.find((c) => c.n === act.candN);
    if (!cand) {
      const detail = `Model chose ${act.action} on candidate [${act.candN}], but that index isn't in this step's observed controls (${cands.length ? cands.map((c) => c.n).join(",") : "none"}) — candidate numbering is recomputed fresh every step, so a stale reference from an earlier step's history silently does nothing.`;
      history.push(`step ${step}: ${detail}`);
      emitAndTrace({ turn: step, action: "fill-failed", detail });
      continue;
    }

    if (act.action === "click") {
      const label = cand.ctx.slice(0, 60) || cand.aria || cand.name || `[${cand.n}]`;
      const urlBefore = page.url();
      const clickOk = await curFrame
        .locator(`[data-co-cand="${cand.n}"]`)
        .first()
        .click({ timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      await page.waitForTimeout(1200);
      await dropNewTabs(page);
      const urlChanged = page.url() !== urlBefore;
      curFrame = await richestFrame(page);

      if (!clickOk) {
        history.push(`step ${step}: FAILED to click [${cand.n}] "${label}" (element not found/clickable)`);
        emitAndTrace({ turn: step, action: "fill-failed", detail: `Tried to click "${label}" but it wasn't clickable.` });
        continue;
      }

      const actionKey = `click:${cand.n}`;
      if (!urlChanged && actionKey === lastActionKey) {
        const detail = `Clicked "${label}" twice in a row with no page change — likely a silent validation failure (a required field is empty or invalid) rather than something more clicking fixes.`;
        logAccountStep({ employer, employerSlug: slug, email, step: "failed", detail });
        emitAndTrace({ turn: step, action: "blocked", detail, thumb: await shot(page) });
        return { reached: false, turns: step, reason: "repeated-no-progress" };
      }
      lastActionKey = actionKey;

      history.push(`step ${step}: clicked [${cand.n}] "${label}"${urlChanged ? "" : " (no page change)"}`);
      emitAndTrace({ turn: step, action: "click", detail: `Clicked "${label}".`, thumb: await shot(page) });
      continue;
    }
    lastActionKey = null;

    const field = candToField(cand);
    const label = field.label || `[${cand.n}]`;
    // actuateField() (ats-account.ts) looks up elements by data-co-field — the
    // tag agentInterpretForm()'s re-tag step sets. captureLiveCandidates() only
    // sets data-co-cand, so without this, every fill/check call below silently
    // matched zero elements and timed out — nothing was ever actually attempted.
    await curFrame.evaluate(
      ({ candN, fieldId }) => document.querySelector(`[data-co-cand="${candN}"]`)?.setAttribute("data-co-field", fieldId),
      { candN: cand.n, fieldId: field.id },
    ).catch(() => {});

    if (act.action === "fill_email") {
      const ok = await actuateField(curFrame, field, email);
      history.push(`step ${step}: ${ok ? "filled" : "FAILED to fill"} email into [${cand.n}] "${label}"`);
      emitAndTrace({ turn: step, action: ok ? "fill" : "fill-failed", detail: ok ? `Filled email into "${label}".` : `Tried to fill email into "${label}" but it didn't land — the field may be read-only, hidden, or a custom widget that needs a click first.` });
    } else if (act.action === "fill_new_password") {
      if (!newPassword) {
        creds = initCredentials(slug, employer, loginDomain, email);
        newPassword = creds.password;
        logAccountStep({ employer, employerSlug: slug, email, step: "account_created" });
        emitAndTrace({ turn: step, action: "account_created", detail: `Generated a new password for a ${employer} account (saved to data/ats-credentials/).` });
      }
      const ok = await actuateField(curFrame, field, newPassword);
      const confirmNote = CONFIRM_PASSWORD_PATTERN.test(field.label) ? " (confirm)" : "";
      history.push(`step ${step}: ${ok ? "filled" : "FAILED to fill"} new password into [${cand.n}] "${label}"${confirmNote}`);
      emitAndTrace({ turn: step, action: ok ? "fill" : "fill-failed", detail: ok ? `Filled new password into "${label}"${confirmNote}.` : `Tried to fill new password into "${label}" but it didn't land.` });
    } else if (act.action === "fill_existing_password") {
      // Use active saved password, or fall back to the password we just
      // generated this run (post-creation sign-in on Workday/Greenhouse etc).
      const pw = creds?.status === "active" ? creds.password : newPassword;
      if (!pw) {
        history.push(`step ${step}: fill_existing_password requested but no password available (not active, none generated yet) — skipped`);
        continue;
      }
      const pwLabel = creds?.status === "active" ? "saved" : "newly created";
      const ok = await actuateField(curFrame, field, pw);
      history.push(`step ${step}: ${ok ? "filled" : "FAILED to fill"} ${pwLabel} password into [${cand.n}] "${label}"`);
      emitAndTrace({ turn: step, action: ok ? "fill" : "fill-failed", detail: ok ? `Filled ${pwLabel} password into "${label}".` : `Tried to fill ${pwLabel} password into "${label}" but it didn't land.` });
    } else if (act.action === "fill_text") {
      const ok = await actuateField(curFrame, field, act.value);
      history.push(`step ${step}: ${ok ? "filled" : "FAILED to fill"} text into [${cand.n}] "${label}"`);
      emitAndTrace({ turn: step, action: ok ? "fill" : "fill-failed", detail: ok ? `Filled "${act.value.slice(0, 40)}" into "${label}".` : `Tried to fill "${act.value.slice(0, 40)}" into "${label}" but it didn't land.` });
    } else if (act.action === "check_consent") {
      const ok = await actuateField(curFrame, field, "true");
      if (ok) logAccountStep({ employer, employerSlug: slug, email, step: "consent_accepted" });
      history.push(`step ${step}: ${ok ? "checked" : "FAILED to check"} consent [${cand.n}] "${label}"`);
      emitAndTrace({ turn: step, action: ok ? "consent" : "fill-failed", detail: ok ? `Accepted Terms/Privacy checkbox: "${label}".` : `Tried to check consent checkbox "${label}" but it didn't land.` });
    }
  }

  const detail = `Gave up after ${MAX_STEPS} steps without reaching the application form.`;
  logAccountStep({ employer, employerSlug: slug, email, step: "failed", detail: `${detail} Trace: ${history.join(" | ")}` });
  emitAndTrace({ turn: MAX_STEPS, action: "stuck", detail, thumb: await shot(page) });
  return { reached: false, turns: MAX_STEPS, reason: "budget-exhausted" };
}
