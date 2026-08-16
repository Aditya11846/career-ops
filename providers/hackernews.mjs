// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';

// Hacker News "Ask HN: Who is hiring?" provider — no auth required.
//
// Algorithm:
//   1. Find the current monthly hiring thread via the Algolia HN search API,
//      scoped to the `whoishiring` bot account that posts it every month
//      (tags=story,author_whoishiring) rather than a free-text query.
//      CONFIRMED LIVE (2026-08-03): a free-text query="Ask HN Who is hiring"
//      does NOT reliably surface the real thread in its top 5 results —
//      Algolia's relevance ranking mixes in similarly-worded but unrelated
//      threads ("Who is dating?", "Who wants to be hired?" meta-discussion,
//      etc.), and the real monthly thread got crowded out entirely in a real
//      test. Scoping to the canonical posting account is exact, not fuzzy —
//      confirmed 506 real hits for that author, all genuine monthly threads.
//   2. Fetch the thread's item from the Algolia items API; top-level `children`
//      are individual job posts left as top-level comments.
//   3. Parse each comment: the first non-empty line is treated as the title/header
//      (many follow "Company | Role | Location | URL" but this is free-form, so
//      we extract defensively — a URL is pulled out wherever it appears; the
//      first line becomes the title; company/location are left empty when the
//      format doesn't match the pipe-delimited convention).
//
// Wire in via a `job_boards:` entry with `provider: hackernews`.

const SEARCH_URL =
  'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10';

/** @param {string} id */
function itemUrl(id) {
  return `https://hn.algolia.com/api/v1/items/${id}`;
}

/**
 * Scan raw text for the first absolute http/https URL. Returns '' if none found.
 * @param {string} text
 */
function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s<>"')]+/);
  return m ? m[0].replace(/[.,;!?)]+$/, '') : '';
}

// Entity decoding delegated to the shared providers/_html-entities.mjs
// decoder (handles named entities AND numeric/hex entities generically) --
// this file's own inline ENTITY_MAP only covered 7 hardcoded entities and
// silently left others (e.g. &#x2F; for "/") undecoded, which showed up as
// literal "&#x2F;" noise throughout every URL and location field in real
// output (confirmed live 2026-08-03). Same drift-risk pattern _html-entities.mjs's
// own header warns about (deutschebahn.mjs/hecklerkoch.mjs had duplicated,
// diverging copies before being centralized) -- reuse it here instead of
// growing a second incomplete copy.

/**
 * Parse a single HN comment text into a normalized job object.
 * The canonical format is "Company | Role | Location | URL" on the first line,
 * but posts are free-form — we only guarantee title (first line) and url (first
 * URL found anywhere in the text). company and location are extracted from the
 * pipe-delimited header when present; left empty otherwise.
 *
 * Exported for unit testing.
 *
 * @param {string} text  Raw comment text (may contain HTML; tags are stripped).
 * @param {string} threadUrl  Fallback url (the HN thread) if no URL in comment.
 * @returns {{ title: string, url: string, company: string, location: string } | null}
 *   null when the comment is empty, deleted, or carries no usable title.
 */
export function parseHnComment(text, threadUrl = '') {
  if (!text || typeof text !== 'string') return null;

  // Strip HTML. Anchors: keep the href value in place so URL extraction works.
  // Block-level tags (<p>, <br>, <div>, <li>, headings) become newlines so that
  // body paragraphs never bleed into the first header line after the join.
  const stripped = text
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>.*?<\/a>/gi, (_, href) => href)
    .replace(/<\/?(?:p|br|div|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const plain = decodeEntities(stripped)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  // Split into lines; first non-blank line is the header.
  const lines = plain.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const firstLine = lines[0];
  if (!firstLine) return null;

  // Try to parse pipe-delimited header: Company | Role | Location | URL (4+ parts)
  // or Company | Role | Location (3 parts).
  const parts = firstLine.split('|').map(p => p.trim());

  let company = '';
  let location = '';

  if (parts.length >= 3) {
    company = parts[0];
    // Role is parts[1] — used in title construction below, not stored separately.
    // Strip any embedded URL from the location field (e.g. when the URL is run
    // into the same pipe segment rather than given its own 4th segment).
    location = parts[2].replace(/https?:\/\/\S+/g, '').trim();
  } else if (parts.length === 2) {
    company = parts[0];
  }
  // Single-part first line: title only, company/location stay empty.

  // Build a clean title from the first line (strip any embedded URL from it).
  const title = firstLine.replace(/https?:\/\/[^\s]+/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!title) return null;

  // Find first URL anywhere in the full text.
  const url = extractUrl(plain) || threadUrl;
  if (!url) return null;

  return { title, url, company, location };
}

/**
 * Find the objectID of the latest "Ask HN: Who is hiring?" story.
 * Returns null when the search yields no matching hits.
 * @param {unknown} data  Parsed Algolia search response.
 */
export function resolveLatestThreadId(data) {
  if (!data || typeof data !== 'object') return null;
  const hits = /** @type {any} */ (data).hits;
  if (!Array.isArray(hits) || hits.length === 0) return null;

  // Algolia search_by_date returns newest first; find the first hit whose title
  // matches the monthly thread pattern (case-insensitive).
  const RE = /ask\s+hn[:\s]+who\s+is\s+hiring/i;
  for (const hit of hits) {
    if (hit && typeof hit.objectID === 'string' && typeof hit.title === 'string') {
      if (RE.test(hit.title)) return hit.objectID;
    }
  }
  return null;
}

/** @type {Provider} */
export default {
  id: 'hackernews',

  async fetch(entry, ctx) {
    // Step 1: Find the latest "Who is hiring?" story id.
    const searchData = await ctx.fetchJson(SEARCH_URL, { redirect: 'error' });
    const threadId = resolveLatestThreadId(searchData);
    if (!threadId) {
      throw new Error('hackernews: could not find "Ask HN: Who is hiring?" thread in search results');
    }

    const threadHnUrl = `https://news.ycombinator.com/item?id=${threadId}`;

    // Step 2: Fetch the thread item (children = top-level job comments).
    const item = await ctx.fetchJson(itemUrl(threadId), { redirect: 'error' });
    if (!item || typeof item !== 'object') {
      throw new Error(`hackernews: unexpected item response for thread ${threadId}`);
    }

    const children = /** @type {any} */ (item).children;
    if (!Array.isArray(children)) return [];

    // Step 3: Parse each comment.
    // REAL BUG FOUND + FIXED LIVE (2026-08-03): passing the shared threadHnUrl
    // as every comment's URL fallback caused mass silent dedup -- most "who is
    // hiring" comments have no embedded URL at all (perfectly normal; they just
    // describe the role and expect a thread reply), so nearly all of them
    // collapsed onto the SAME fallback URL, and scan.mjs's URL-based dedup
    // reduced ~270 real distinct postings down to 1. Confirmed live: a raw
    // parse of the first 20 comments in a real thread produced 20 unique
    // results when each got its OWN comment permalink as the fallback, vs.
    // effectively 1 when they shared the thread URL. Each comment's own
    // permalink is also more correct on its own merits -- it links directly to
    // the specific posting, not the whole 276-comment thread.
    const jobs = [];
    for (const child of children) {
      // Skip deleted / dead / empty comments.
      if (!child || child.deleted || child.dead) continue;
      const text = typeof child.text === 'string' ? child.text : '';
      if (!text.trim()) continue;

      const commentUrl = child.id ? `https://news.ycombinator.com/item?id=${child.id}` : threadHnUrl;
      const parsed = parseHnComment(text, commentUrl);
      if (!parsed) continue;

      jobs.push({
        title: parsed.title,
        url: parsed.url,
        company: parsed.company || (entry.name || 'HN Hiring'),
        location: parsed.location,
        // Algolia returns created_at as ISO string.
        ...(child.created_at
          ? { postedAt: Date.parse(child.created_at) || undefined }
          : {}),
      });
    }

    return jobs;
  },
};
