// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// schema.org JobPosting (JSON-LD) provider — reads the structured-data block
// most modern company career pages embed for Google for Jobs indexing. Works
// on ANY company's own careers/job page regardless of which ATS (or none)
// powers it underneath — the one genuine way to reach companies outside the
// four API-backed providers (greenhouse/ashby/lever/workday) without a
// per-company scraper.
//
// Unlike the other providers, there is no URL-hostname pattern to auto-detect
// (a company's own domain, not a shared ATS host) — this provider never
// self-detects. Wire it in explicitly via `provider: jsonld-jobposting` on a
// tracked_companies/job_boards entry, with `careers_url` pointing at either a
// single job's detail page (most common — the page's own JobPosting IS that
// job) or a listing page embedding multiple JobPosting blocks.

/** @param {string} url */
function assertHttpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`jsonld-jobposting: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`jsonld-jobposting: URL must use HTTPS: ${url}`);
  return url;
}

function stripHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// A JobPosting's jobLocation can be a single Place, an array of Places, or
// absent entirely (common for fully-remote postings, which instead set
// jobLocationType: "TELECOMMUTE"). Best-effort join, never throws.
function formatLocation(item) {
  const locs = Array.isArray(item?.jobLocation) ? item.jobLocation : item?.jobLocation ? [item.jobLocation] : [];
  const parts = locs
    .map(loc => {
      const addr = loc?.address;
      if (!addr) return '';
      return [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ');
    })
    .filter(Boolean);
  if (parts.length) return parts.join(' | ');
  if (item?.jobLocationType === 'TELECOMMUTE' || item?.applicantLocationRequirements) return 'Remote';
  return '';
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// Flatten a parsed JSON-LD document into its candidate node list — handles a
// bare object, a top-level array, and a `@graph`-wrapped document (all three
// are seen in the wild).
function flattenNodes(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data['@graph'])) return data['@graph'];
  return data ? [data] : [];
}

function isJobPostingType(node) {
  const type = node?.['@type'];
  if (typeof type === 'string') return type === 'JobPosting';
  if (Array.isArray(type)) return type.includes('JobPosting');
  return false;
}

/**
 * Parse a page's embedded JSON-LD script blocks into normalized jobs.
 * Exported for unit tests.
 *
 * @param {string} html
 * @param {{ fallbackCompany?: string, fallbackUrl?: string }} [opts]
 * @returns {Array<{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}>}
 */
export function parseJobPostingJsonLd(html, opts = {}) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const fallbackCompany = typeof opts.fallbackCompany === 'string' ? opts.fallbackCompany.trim() : '';
  const fallbackUrl = typeof opts.fallbackUrl === 'string' ? opts.fallbackUrl.trim() : '';

  const jobs = [];
  const scriptMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);

  for (const match of scriptMatches) {
    let data;
    try {
      data = JSON.parse(match[1]);
    } catch {
      continue; // Malformed JSON-LD — skip this block, keep scanning others.
    }

    for (const node of flattenNodes(data)) {
      if (!isJobPostingType(node)) continue;

      const title = typeof node.title === 'string' ? node.title.trim() : '';
      if (!title) continue;

      // Most single-job detail pages don't repeat their own URL inside the
      // JobPosting block — the page IS the posting. Fall back to the page
      // URL we fetched; only skip the job if neither is available.
      let url = '';
      if (typeof node.url === 'string' && node.url.trim()) {
        url = node.url.trim();
      } else if (fallbackUrl) {
        url = fallbackUrl;
      }
      if (!url) continue;

      const company =
        (typeof node.hiringOrganization?.name === 'string' && node.hiringOrganization.name.trim()) ||
        fallbackCompany ||
        '';

      jobs.push({
        title,
        url,
        company,
        location: formatLocation(node),
        description: stripHtml(node.description),
        postedAt: toEpochMs(node.datePosted),
      });
    }
  }

  return jobs;
}

/** @type {Provider} */
export default {
  id: 'jsonld-jobposting',

  // Never self-detects — schema.org markup isn't a URL-hostname pattern like
  // the ATS providers. Only ever selected via an entry's explicit
  // `provider: jsonld-jobposting` field (resolveProvider's explicit-field
  // resolution step wins over detect() for every provider, this one included).
  detect() {
    return null;
  },

  async fetch(entry, ctx) {
    const url = entry?.careers_url;
    if (!url) throw new Error(`jsonld-jobposting: entry "${entry?.name}" has no careers_url`);
    assertHttpsUrl(url);
    const html = await ctx.fetchText(url, { redirect: 'error' });
    return parseJobPostingJsonLd(html, { fallbackCompany: entry.name, fallbackUrl: url });
  },
};

// --- Self-test ---
async function runSelfTest() {
  let failed = false;
  const assert = (cond, label) => {
    if (!cond) {
      console.error(`FAIL ${label}`);
      failed = true;
    } else {
      console.log(`PASS ${label}`);
    }
  };

  // 1. Single JobPosting, no url field — should fall back to fallbackUrl.
  const single = `
    <html><head>
    <script type="application/ld+json">
    {"@context":"https://schema.org/","@type":"JobPosting","title":"Zero Trust Engineer",
     "hiringOrganization":{"@type":"Organization","name":"Acme Security"},
     "jobLocation":{"@type":"Place","address":{"addressLocality":"Berlin","addressCountry":"DE"}},
     "datePosted":"2026-06-01","description":"<p>Build <b>Zero Trust</b> stuff.</p>"}
    </script>
    </head><body></body></html>`;
  const jobs1 = parseJobPostingJsonLd(single, { fallbackCompany: 'Acme Security', fallbackUrl: 'https://acme.example/careers/123' });
  assert(jobs1.length === 1, 'single JobPosting parses to one job');
  assert(jobs1[0]?.title === 'Zero Trust Engineer', 'title extracted');
  assert(jobs1[0]?.url === 'https://acme.example/careers/123', 'missing url falls back to page url');
  assert(jobs1[0]?.company === 'Acme Security', 'company extracted from hiringOrganization');
  assert(jobs1[0]?.location === 'Berlin, DE', 'location joined from address parts');
  assert(jobs1[0]?.description === 'Build Zero Trust stuff.', 'description HTML stripped');
  assert(jobs1[0]?.postedAt === Date.parse('2026-06-01'), 'postedAt parsed to epoch ms');

  // 2. @graph-wrapped document with a non-JobPosting sibling node.
  const graphed = `
    <script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"Organization","name":"Ignore Me"},
      {"@type":"JobPosting","title":"Embedded Kernel Engineer","url":"https://acme.example/jobs/9",
       "hiringOrganization":{"name":"Acme Security"},"jobLocationType":"TELECOMMUTE"}
    ]}
    </script>`;
  const jobs2 = parseJobPostingJsonLd(graphed, { fallbackCompany: 'Acme Security' });
  assert(jobs2.length === 1, '@graph-wrapped JobPosting found, non-JobPosting sibling ignored');
  assert(jobs2[0]?.url === 'https://acme.example/jobs/9', 'explicit url used when present');
  assert(jobs2[0]?.location === 'Remote', 'TELECOMMUTE with no jobLocation reports Remote');

  // 3. No JobPosting block at all.
  const none = `<script type="application/ld+json">{"@type":"Organization","name":"Nobody Hiring"}</script>`;
  assert(parseJobPostingJsonLd(none).length === 0, 'page with no JobPosting returns empty array, not an error');

  // 4. Malformed JSON-LD block is skipped, not thrown.
  const malformed = `<script type="application/ld+json">{not valid json</script>`;
  let threw = false;
  try {
    parseJobPostingJsonLd(malformed);
  } catch {
    threw = true;
  }
  assert(!threw, 'malformed JSON-LD is skipped silently, never throws');

  // 5. detect() never self-detects.
  assert(
    (await import('./jsonld-jobposting.mjs')).default.detect({ careers_url: 'https://acme.example/careers' }) === null,
    'detect() always returns null — explicit provider: field required'
  );

  // 6. fetch() rejects a non-https careers_url before making any request.
  let rejectedHttp = false;
  try {
    await (await import('./jsonld-jobposting.mjs')).default.fetch({ name: 'Acme', careers_url: 'http://acme.example/careers' }, {});
  } catch {
    rejectedHttp = true;
  }
  assert(rejectedHttp, 'fetch() rejects non-HTTPS careers_url');

  if (failed) {
    console.error('\nSelf-test FAILED');
    process.exitCode = 1;
  } else {
    console.log('\nSelf-test PASSED');
  }
}

if (process.argv[1] && process.argv[1].endsWith('jsonld-jobposting.mjs') && process.argv.includes('--self-test')) {
  runSelfTest();
}
