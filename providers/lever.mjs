// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Lever provider — hits the public postings endpoint.
// Auto-detects from careers_url via jobs.(eu.)?lever.co/<slug>.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.

const ALLOWED_LEVER_HOSTS = new Set(['api.lever.co', 'api.eu.lever.co']);

/** @param {string} url */
function assertLeverUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`lever: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`lever: URL must use HTTPS: ${url}`);
  if (!ALLOWED_LEVER_HOSTS.has(parsed.hostname))
    throw new Error(`lever: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_LEVER_HOSTS].join(', ')}`);
  return url;
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  // Explicit api: wins — lets an entry keep a human-facing corporate
  // careers_url (e.g. https://www.coalfire.com/careers) while still pinning
  // the Lever postings board (mirrors greenhouse's api: precedence).
  if (entry.api) {
    assertLeverUrl(entry.api);
    return entry.api;
  }
  let url;
  try {
    url = new URL(entry.careers_url || '');
  } catch {
    return null;
  }
  const host = url.hostname.match(/^jobs\.((?:eu\.)?lever\.co)$/);
  if (!host) return null;
  const slug = url.pathname.split('/').filter(Boolean)[0];
  if (!slug) return null;
  return `https://api.${host[1]}/v0/postings/${slug}`;
}

// Lever's v0 postings list can carry a salaryRange object on some postings
// (most omit it — no-op when absent, never fabricated). min/max are in the
// listed currency.
function parseSalary(j) {
  const r = j?.salaryRange;
  if (!r || typeof r !== 'object') return undefined;
  const clean = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const min = clean(r.min);
  const max = clean(r.max);
  if (min == null && max == null) return undefined;
  const currency = typeof r.currency === 'string' ? r.currency.trim().toUpperCase() : '';
  return { min, max, currency };
}

/** @type {Provider} */
export default {
  id: 'lever',
  maxConcurrency: 5,

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`lever: cannot derive API URL for ${entry.name}`);
    assertLeverUrl(apiUrl);
    // fetchJsonRetry: Lever's postings API rate-limits under load — the shared
    // backoff+jitter retry (Smart 4) absorbs transient 429/5xx without noise.
    const json = await ctx.fetchJsonRetry(apiUrl, { redirect: 'error' });
    if (!Array.isArray(json)) return [];
    return json.map(j => ({
      title: j.text || '',
      url: j.hostedUrl || '',
      company: entry.name,
      location: j.categories?.location || '',
      salary: parseSalary(j),
      // Lever's v0 postings list ships the full description for free (same
      // payload, no per-job request) — enables scan.mjs content_filter.
      description: typeof j.descriptionPlain === 'string' ? j.descriptionPlain : '',
      postedAt: typeof j.createdAt === 'number' ? j.createdAt : undefined,
    }));
  },
};
