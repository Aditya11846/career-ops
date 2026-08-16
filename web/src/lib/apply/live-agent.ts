import type { Frame, Page } from "playwright-core";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot } from "@/lib/career-ops";
import { runPlanner } from "./agent-interpret";
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

const MAX_STEPS = 15;

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

function buildDecidePrompt(company: string, role: string, cands: Cand[], hasEmail: boolean, hasCreds: boolean, history: string[]): string {
  const lines = cands
    .map((c) => `[${c.n}] tag=${c.tag} type=${c.type}${c.req ? " required" : ""}${c.name ? ` name="${c.name}"` : ""}${c.placeholder ? ` placeholder="${c.placeholder}"` : ""}${c.aria ? ` aria="${c.aria}"` : ""}${c.opts.length ? ` options=[${c.opts.slice(0, 12).join(" | ")}]` : ""} | context: "${c.ctx}"`)
    .join("\n");
  return `You are driving a real browser toward one goal: reach and fill out the job application form for "${role}" at "${company}". Some employer sites require signing in or creating an account first — you may need to create one.

Facts available to you (values are NOT shown to you — reference them only by name):
- candidate email: ${hasEmail ? "available" : "NOT available — cannot create an account or log in"}
- existing saved credentials for this employer: ${hasCreds ? "available (email + password already saved)" : "not available yet"}

IMPORTANT: if no existing credentials are available and the current page is a SIGN IN form (asking to log into an account you don't have), do NOT fill it — click "Create Account" / "Sign Up" / "Register" instead, wherever that link/button is. Only fill a Sign In form's fields when existing credentials ARE available.

CONTROLS ON THE CURRENT PAGE:
${lines || "(no interactive controls found)"}

Decide EXACTLY ONE next action. Return ONLY a JSON object, no prose, no code fence, one of:
{"action":"click","candN":<n>}
{"action":"fill_email","candN":<n>}
{"action":"fill_new_password","candN":<n>}          // only when creating a NEW account
{"action":"fill_existing_password","candN":<n>}      // only when existing credentials are available
{"action":"fill_text","candN":<n>,"value":"<text>"}  // any other benign text field (e.g. a name field some signups ask for)
{"action":"check_consent","candN":<n>}                // a Terms/Privacy consent checkbox blocking signup
{"action":"wait_for_email"}                            // you just submitted a signup form and expect a verification email
{"action":"ready_to_fill"}                              // this page IS the actual job application form now (has resume/first name/last name/etc fields) — stop here, a separate step fills it
{"action":"blocked","reason":"<why>"}                   // a real CAPTCHA, MFA challenge, or genuinely no way to proceed

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

/** True once the current controls look like the REAL application form
 *  (resume/name/etc), not a login/signup/intermediate page — mirrors
 *  session.ts's looksLikeApplicationForm() heuristic at the candidate level
 *  so the model's own "ready_to_fill" call can be sanity-checked. */
function candsLookLikeApplication(cands: Cand[]): boolean {
  return cands.some((c) => /resume|résumé|\bcv\b|cover letter|first name|last name|full name/i.test(c.ctx || c.aria || c.placeholder || ""));
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

  let curFrame = frame;
  const history: string[] = [];
  let newPassword: string | null = null;
  let lastActionKey: string | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const cands = await captureLiveCandidates(curFrame).catch(() => [] as Cand[]);

    if (candsLookLikeApplication(cands)) {
      logAccountStep({ employer, employerSlug: slug, email, step: "application_filled", detail: `reached application form after ${step} step(s)` });
      emitAndTrace({ turn: step, action: "reached", detail: `Reached the real application form after ${step} step(s).`, thumb: await shot(page) });
      return { reached: true, turns: step, reason: "reached" };
    }

    const prompt = buildDecidePrompt(employer, role, cands, true, creds?.status === "active", history);
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

    // Field/click actions target a captured candidate by index.
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
      // "created"/"verified" means a signup attempt started but was never
      // confirmed to have actually worked on the employer's side — not safe
      // to treat as a real, usable login. Only "active" (a prior successful
      // login) counts.
      if (creds?.status !== "active") {
        history.push(`step ${step}: fill_existing_password requested but no CONFIRMED working credentials exist — skipped`);
        continue;
      }
      const ok = await actuateField(curFrame, field, creds.password);
      history.push(`step ${step}: ${ok ? "filled" : "FAILED to fill"} existing password into [${cand.n}] "${label}"`);
      emitAndTrace({ turn: step, action: ok ? "fill" : "fill-failed", detail: ok ? `Filled saved password into "${label}".` : `Tried to fill saved password into "${label}" but it didn't land.` });
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
