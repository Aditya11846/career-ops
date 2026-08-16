import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

export type AtsAccountStatus = "created" | "verified" | "active";

export type AtsCredentials = {
  employer: string;
  /** The login-gated host this account lives on, e.g. broadcom.wd5.myworkdayjobs.com
   *  or a Greenhouse/Lever/custom-portal account host — whatever site required
   *  a login, not specifically Workday. */
  loginDomain: string;
  email: string;
  password: string;
  status: AtsAccountStatus;
  createdAt: string;
  lastUsedAt: string | null;
};

function credentialsDir(): string {
  return join(careerOpsRoot(), "data", "ats-credentials");
}

function credentialsPath(employerSlug: string): string {
  return join(credentialsDir(), `${employerSlug}.json`);
}

/** Generates a strong password that satisfies typical signup complexity
 *  rules (upper/lower/digit/symbol, 16 chars). */
export function generatePassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*-_=+";
  const all = upper + lower + digits + symbols;
  const pick = (pool: string) => pool[randomBytes(1)[0] % pool.length];
  const required = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  const rest = Array.from({ length: 12 }, () => pick(all));
  const chars = [...required, ...rest];
  // Fisher-Yates shuffle using crypto randomness so the required chars
  // aren't always in the same leading positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export function getCredentials(employerSlug: string): AtsCredentials | null {
  const p = credentialsPath(employerSlug);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AtsCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(employerSlug: string, creds: AtsCredentials): void {
  const dir = credentialsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = credentialsPath(employerSlug);
  writeFileSync(p, JSON.stringify(creds, null, 2), "utf8");
  try {
    chmodSync(p, 0o600);
  } catch {
    // best-effort on platforms where chmod semantics differ
  }
}

export function markStatus(employerSlug: string, status: AtsAccountStatus): AtsCredentials | null {
  const creds = getCredentials(employerSlug);
  if (!creds) return null;
  creds.status = status;
  creds.lastUsedAt = new Date().toISOString();
  saveCredentials(employerSlug, creds);
  return creds;
}

/** Creates and persists a brand-new credential record with status "created",
 *  BEFORE the signup form is submitted — so a mid-flow failure never loses
 *  the generated password. */
/** Idempotent by employerSlug: a prior run may have already generated a
 *  password and attempted signup (status "created") without confirming it
 *  actually went through on the employer's side. Reusing that same
 *  password on retry avoids fragmenting into multiple different passwords
 *  scattered across partial signup attempts for the same real account. Only
 *  generates a genuinely new password when no record exists yet at all. */
export function initCredentials(employerSlug: string, employer: string, loginDomain: string, email: string): AtsCredentials {
  const existing = getCredentials(employerSlug);
  if (existing && existing.status !== "active") return existing;
  const creds: AtsCredentials = {
    employer,
    loginDomain,
    email,
    password: generatePassword(),
    status: "created",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  saveCredentials(employerSlug, creds);
  return creds;
}
