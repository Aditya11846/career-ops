import type { Frame, Locator, Page } from "playwright-core";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import yaml from "js-yaml";
import { getCredentials, initCredentials, markStatus, type AtsCredentials } from "./ats-credentials";
import { agentInterpretForm } from "./agent-interpret";
import type { ApplyField } from "./extract";
import { careerOpsRoot } from "@/lib/career-ops";

// The Node/tsx (apply-agent/) and Next.js/SWC (web/) toolchains don't
// statically import across their boundary in this codebase — orchestrator.ts
// documents a real bug from crossing it the other direction (esbuild's
// __name shim breaking a Playwright closure). This writes to the SAME
// data/ats-account-log.jsonl file apply-agent/account-creation-log.mjs uses,
// independently, so either toolchain's callers land in one shared audit trail.
export type AccountLogStep = "account_created" | "consent_accepted" | "verification_email_received" | "account_activated" | "logged_in" | "application_filled" | "application_submitted" | "failed";

export function logAccountStep(entry: { employer: string; employerSlug: string; email: string; step: AccountLogStep; detail?: string }): void {
  const logPath = join(careerOpsRoot(), "data", "ats-account-log.jsonl");
  const record = { timestamp: new Date().toISOString(), ...entry, detail: entry.detail ?? null };
  if (!existsSync(dirname(logPath))) mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(record) + "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// ATS ACCOUNT PRIMITIVES — reusable building blocks for live-agent.ts's
// observe-decide-act loop (the loop decides WHAT to do on a login/signup
// page; this module supplies the low-level HOW: field actuation, the
// credential store, email-verification polling, and a fast deterministic
// login path for employers we already have a working account with).
//
// This file used to also contain the decision logic (was this page a signup
// or a login form? how many links to click through to reach it?) — that was
// a fixed classifier guessing at page semantics per-ATS, and it kept
// breaking on real sites. live-agent.ts replaces it with a live, per-step
// LLM decision instead. See that file for the loop.
//
// No human checkpoint: every step is written to the audit log
// (account-creation-log.mjs / data/ats-account-log.jsonl) instead of pausing.
// Genuine blockers (captcha, mfa, an email verification link that never
// arrives) still fall through to the caller's existing blocking-issue path —
// nothing here attempts to defeat a real CAPTCHA.
// ─────────────────────────────────────────────────────────────────────────────

export const CONSENT_PATTERN = /\b(i (have )?read|i agree|i consent|i accept|consent to|privacy notice|terms|gdpr|data protection)\b/i;
export const CONFIRM_PASSWORD_PATTERN = /confirm password|re-?type password|repeat password|verify password/i;

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function cssAttr(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Core actuation primitive: fill a resolved DOM element (locator) with a
 *  value, verifying it actually landed. Shared by actuateField() (app-side,
 *  targets a data-co-field-tagged element) and the secret MCP server
 *  (standalone process, targets document.activeElement) — the two codebases
 *  can't statically import across the toolchain boundary, so each builds a
 *  Locator and delegates to this.
 *
 *  Some Workday/custom-component inputs don't register a bare .fill() as a
 *  real interaction unless the field is focused first (their own JS
 *  validation listens for real focus/input events). Click to focus, fill,
 *  then verify the value actually landed — fall back to character-by-
 *  character typing if it didn't, same fallback the combobox path above uses. */
export async function actuateLocator(loc: Locator, page: Page, field: Pick<ApplyField, "type" | "combobox">, value: string): Promise<boolean> {
  try {
    if (field.type === "checkbox") {
      await loc.click();
      return true;
    }
    if (field.type === "select" || field.combobox) {
      await loc.click();
      await page.waitForTimeout(150);
      await loc.pressSequentially(value, { delay: 15 }).catch(async () => {
        await page.keyboard.type(value);
      });
      return true;
    }
    await loc.click({ timeout: 3000 }).catch(() => {});
    await loc.fill(value);
    if ((await loc.inputValue().catch(() => "")) !== value) {
      await loc.fill("").catch(() => {});
      await loc.pressSequentially(value, { delay: 15 }).catch(async () => {
        await page.keyboard.type(value);
      });
    }
    return (await loc.inputValue().catch(() => "")) === value;
  } catch {
    return false;
  }
}

/** Fills a captured field via its data-co-field tag (same tagging
 *  agentInterpretForm() already applies), mirroring fillSession()'s
 *  actuation primitive. Consent checkboxes ARE ticked here — this session's
 *  explicit decision, scoped to this account-creation flow only. Real
 *  application forms (fillSession in session.ts) keep refusing to auto-tick
 *  consent — that rule is untouched. */
export async function actuateField(frame: Frame, field: ApplyField, value: string): Promise<boolean> {
  try {
    const loc = frame.locator(`[data-co-field="${cssAttr(field.id)}"]`).first();
    return await actuateLocator(loc, frame.page(), field, value);
  } catch {
    return false;
  }
}

/** Best-effort employer name derivation from the page host/title —
 *  good enough for a slug key; the credential record also stores the
 *  human-readable title as `employer` for the audit log. */
export function employerFromPage(url: string, title: string): { employer: string; slug: string; loginDomain: string } {
  let loginDomain = "";
  try {
    loginDomain = new URL(url).host;
  } catch {
    loginDomain = url;
  }
  // Workday tenant subdomains reliably encode the company (broadcom.wd1.myworkdayjobs.com
  // → "broadcom") — the job title itself often has no company suffix to parse
  // (e.g. Broadcom's postings are titled just "Staff Security Engineer").
  const wdTenant = loginDomain.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i)?.[1];
  const titleDerived = title.replace(/\s*[-–|]\s*(careers|jobs|apply|sign in|log ?in|create account).*/i, "").trim();
  const employer = (wdTenant && wdTenant.replace(/-/g, " ")) || titleDerived || loginDomain;
  return { employer, slug: slugify(wdTenant || employer || loginDomain), loginDomain };
}

export async function fillAndSubmit(frame: Frame, fields: ApplyField[], values: Record<string, string>): Promise<void> {
  for (const f of fields) {
    if (f.type === "file") continue;
    const value = values[f.id];
    if (value === undefined) {
      // consent checkboxes with no explicit value still get ticked here
      if (f.type === "checkbox" && CONSENT_PATTERN.test(f.label || "")) {
        await actuateField(frame, f, "true");
      }
      continue;
    }
    await actuateField(frame, f, value);
  }
}

// Ported (not imported — see the toolchain-boundary note above) from
// plugins/gmail/_helpers.mjs's extractUrls/getMessageBody/isAuthenticEmail.
function extractUrls(body: string): string[] {
  if (!body) return [];
  const urls: string[] = [];
  const regex = /https?:\/\/[^\s"'<>()]+/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    urls.push(match[0].replace(/[.,;:!?]+$/, "").replace(/&amp;/g, "&"));
  }
  return [...new Set(urls)];
}

function getMessageBody(payload: { body?: { data?: string }; parts?: unknown[] } | undefined): string {
  if (!payload) return "";
  let body = "";
  if (payload.body?.data) {
    const base64 = payload.body.data.replace(/-/g, "+").replace(/_/g, "/");
    body += Buffer.from(base64, "base64").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) body += getMessageBody(part as typeof payload);
  }
  return body;
}

function isAuthenticEmail(headers: { name?: string; value?: string }[]): boolean {
  if (!Array.isArray(headers)) return false;
  for (const h of headers) {
    if (h.name?.toLowerCase() === "authentication-results" && h.value && /dmarc=pass/i.test(h.value)) return true;
  }
  return false;
}

/** Reads whatever email-verification message has arrived for this employer's
 *  login domain, using career-ops's existing Gmail plugin OAuth credentials
 *  (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN in .env) — NOT the Gmail MCP tools,
 *  which only exist inside an interactive Claude Code session, not this
 *  server process. Mirrors plugins/gmail/index.mjs's own auth+fetch pattern
 *  without modifying that file (it's documented as a stable reference seed).
 */
export async function waitForVerificationEmail(loginDomain: string, email: string, timeoutMs: number): Promise<string | null> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("ats-account: missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN in .env — required to read the verification email");
  }

  // Zero-dependency domain match. Naively taking the last two labels
  // collapses to the bare public suffix (e.g. "co.uk", "com.au") for any
  // employer on a multi-label ccTLD, which would then accept a verification
  // link from ANY unrelated same-suffix sender (#bug_013). Instead, accept
  // only the full loginDomain or its immediate parent (one label up, so
  // e.g. mail from "apply.acme.co.uk" still matches "careers.acme.co.uk").
  const domainLabels = loginDomain.split(".");
  const acceptedDomains = [loginDomain, ...(domainLabels.length > 2 ? [domainLabels.slice(1).join(".")] : [])];
  const matchesAcceptedDomain = (from: string) => acceptedDomains.some((d) => from.endsWith(`@${d}`) || from.endsWith(`.${d}`));

  const getAccessToken = async (): Promise<string> => {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    if (!res.ok) throw new Error(`ats-account: Gmail token refresh failed: ${res.status}`);
    const data = await res.json();
    if (!data.access_token) throw new Error("ats-account: Gmail token refresh returned no access_token");
    return data.access_token;
  };

  const deadline = Date.now() + timeoutMs;
  const token = await getAccessToken();
  const auth = { Authorization: `Bearer ${token}` };

  while (Date.now() < deadline) {
    const query = `to:${email} newer_than:1d`;
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}`, { headers: auth });
    const list = await listRes.json();
    for (const m of list.messages || []) {
      const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: auth });
      const msg = await detailRes.json();
      const headers = msg.payload?.headers || [];
      if (!isAuthenticEmail(headers)) continue; // fail-closed on unauthenticated/spoofed mail
      const from = (headers.find((h: { name?: string }) => h.name?.toLowerCase() === "from")?.value || "").toLowerCase();
      if (!matchesAcceptedDomain(from)) continue;
      const links = extractUrls(getMessageBody(msg.payload)).filter((u: string) => /verify|confirm|activate/i.test(u));
      if (links.length) return links[0];
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

/** Reads the candidate's email straight from config/profile.yml — the same
 *  user-layer source of truth every other mode reads from (AGENTS.md's
 *  Source-of-Truth Boundary). No profile-loading helper exists yet in web/,
 *  so this is a minimal, self-contained read via the yaml dep already in
 *  web/package.json. */
export function loadCandidateEmail(): string | null {
  try {
    const raw = readFileSync(join(careerOpsRoot(), "config", "profile.yml"), "utf8");
    const parsed = yaml.load(raw) as { candidate?: { email?: string } };
    return parsed?.candidate?.email || null;
  } catch {
    return null;
  }
}

/** Main entry point. Returns true once the page is ready for the caller to
 *  re-run its normal extractForm()/pickFormFrame() pass against the now-
 *  authenticated application form. Returns false if this flow could not
 *  proceed (no signup path found, verification never arrived) — the caller
 *  should fall through to its existing blocking-issue handling in that case. */

/** Deterministic fast path for an employer we already have a working
 *  ("active") account with: skip the live decision loop entirely and just
 *  log in directly. This is a real optimization, not a guess — the loop
 *  already succeeded here once; every application after the first at this
 *  employer is free/fast, not another LLM-driven exploration. */
export async function attemptFastLogin(page: Page, frame: Frame, creds: AtsCredentials, cliId: string, employer: string, slug: string): Promise<boolean> {
  const title = await page.title().catch(() => "");
  const fields = await agentInterpretForm(frame, cliId, title);
  if (!fields.length) {
    logAccountStep({ employer, employerSlug: slug, email: creds.email, step: "failed", detail: "no interpretable login form" });
    return false;
  }
  const values: Record<string, string> = {};
  for (const f of fields) {
    const label = (f.label || "").toLowerCase();
    if (f.type === "email" || /e-?mail|username/.test(label)) values[f.id] = creds.email;
    else if (/password/.test(label)) values[f.id] = creds.password;
  }
  await fillAndSubmit(frame, fields, values);
  await page.waitForTimeout(1500);
  markStatus(slug, "active");
  logAccountStep({ employer, employerSlug: slug, email: creds.email, step: "logged_in" });
  return true;
}
