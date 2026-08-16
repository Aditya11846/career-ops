// HTTP transport helpers shared across providers.
// Files prefixed with _ are never loaded as providers by scan.mjs.

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; career-ops/1.3)';

/**
 * Browser-like User-Agent for providers that must clear WAF/CDN bot
 * management blocking the default career-ops UA outright (seen live:
 * Glints' firewall, Geico's Cloudflare-gated Workday tenant). Shared so
 * every provider working around such a block bumps one constant instead
 * of drifting Chrome versions independently per file.
 */
export const BROWSER_LIKE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body = null, redirect = 'follow' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'user-agent': DEFAULT_USER_AGENT, ...headers },
      body,
      redirect,
      signal: controller.signal,
    });
    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      // WAF/CDN challenge pages (seen live: Workday 429s) carry no actionable
      // text — HTML markup or a generic interstitial message, not worth
      // parsing or displaying. The status code and its standard reason
      // phrase are what a log line needs; the raw body is still attached as
      // err.body for callers that want to inspect it.
      const err = new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
      err.status = res.status;
      err.body = responseText;
      err.retryAfter = res.headers.get('retry-after');
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  return await res.json();
}

export async function fetchText(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  return await res.text();
}

// ── Shared retry policy (Smart 4) ───────────────────────────────────
// The Workday retry policy (providers/workday.mjs) promoted to the shared HTTP
// context so any provider hitting a WAF/rate-limited API (greenhouse, lever)
// gets the same bounded exponential backoff + jitter without reimplementing it.
// Deliberately mirrors workday's constants so behaviour across providers is
// consistent. Non-transient 4xx errors are NOT retried — retrying a malformed
// request just wastes the budget.

const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;

/** Parses a `Retry-After` header value (seconds, or an HTTP-date) to ms, or null. */
export function parseRetryAfterMs(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

export function isRetryableError(err) {
  const status = err?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  return status === undefined; // network error / timeout / abort — no status set
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches with bounded exponential backoff + jitter on transient failures.
 * A server-supplied `Retry-After` is honored but clamped to
 * RETRY_MAX_DELAY_MS*4 — an unbounded value would stall the fetch for as
 * long as the server says (same reasoning as workday).
 */
export async function fetchWithRetry(url, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
    try {
      return await fetchWithTimeout(url, opts);
    } catch (err) {
      lastErr = err;
      if (attempt === DEFAULT_MAX_RETRIES || !isRetryableError(err)) throw err;
      const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
      const retryAfterMs = parseRetryAfterMs(err?.retryAfter);
      const delayMs = retryAfterMs !== null ? Math.min(retryAfterMs, RETRY_MAX_DELAY_MS * 4) : (backoff + Math.random() * 250);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

export async function fetchJsonRetry(url, opts = {}) {
  const res = await fetchWithRetry(url, opts);
  return await res.json();
}

export async function fetchTextRetry(url, opts = {}) {
  const res = await fetchWithRetry(url, opts);
  return await res.text();
}

// Backward-compat aliases — providers not yet migrated to the 1A names
export const fetchJsonWithRetry = fetchJsonRetry;
export const fetchTextWithRetry = fetchTextRetry;

export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson,
    fetchText,
    fetchJsonRetry,
    fetchTextRetry,
  };
}
