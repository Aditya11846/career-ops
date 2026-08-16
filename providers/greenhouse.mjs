// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Greenhouse provider — hits the public boards-api JSON endpoint.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.

const ALLOWED_GREENHOUSE_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

/** @param {string} url */
function assertGreenhouseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`greenhouse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`greenhouse: URL must use HTTPS: ${url}`);
  if (!ALLOWED_GREENHOUSE_HOSTS.has(parsed.hostname))
    throw new Error(`greenhouse: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_GREENHOUSE_HOSTS].join(', ')}`);
  return url;
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  if (entry.api) {
    assertGreenhouseUrl(entry.api);
    return entry.api;
  }
  const url = entry.careers_url || '';
  const match = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (match) return `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs`;
  return null;
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// Greenhouse's v1 jobs list can carry per-posting salary_min/max/currency on
// SOME boards (most omit them entirely). Parse defensively — absent fields
// return undefined ("providers without omit"), never a fabricated range. Values
// are annualized by Greenhouse when present; null for a missing end.
function parseSalary(j) {
  const clean = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const min = clean(j.salary_min);
  const max = clean(j.salary_max);
  if (min == null && max == null) return undefined;
  const currency = typeof j.salary_currency === 'string' ? j.salary_currency.trim().toUpperCase() : '';
  return { min, max, currency };
}

/** @type {Provider} */
export default {
  id: 'greenhouse',
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
    if (!apiUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
    assertGreenhouseUrl(apiUrl);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertGreenhouseUrl above it guarantees the final hostname stays in the allowlist.
    // fetchJsonRetry: the boards API rate-limits under load — the shared
    // backoff+jitter retry (Smart 4) absorbs transient 429/5xx without noise.
    const json = /** @type {any} */ (await ctx.fetchJsonRetry(apiUrl, { redirect: 'error' }));
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs.filter(/** @param {any} j */ j => j.absolute_url).map(/** @param {any} j */ j => ({
      title: j.title || '',
      url: j.absolute_url,
      company: entry.name,
      location: j.location?.name || '',
      salary: parseSalary(j),
      postedAt: toEpochMs(j.first_published),
    }));
  },
};
