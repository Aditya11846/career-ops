import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot, readMemory } from "@/lib/career-ops";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // a real oferta evaluation / pdf-mode CV tailoring + render is heavy and multi-step

// The web ORCHESTRATES the real career-ops engine — it does NOT reimplement it.
// kind "evaluate" runs the REAL modes/oferta.md and persists the canonical
// artifacts (A–F report + tracker row) via the SAME scripts the CLI uses
// (reserve-report-num.mjs → reports/ → batch/tracker-additions/ → merge-tracker.mjs),
// so a web evaluation is byte-identical to a CLI one (single source of truth, no
// drift). kind "research" stays read-only. Streams progress as NDJSON events.
function buildPrompt(kind: string, input: string, memory: string, today: string): string {
  const mem = memory.trim() ? `\n\nDurable notes about the user (from their profile):\n${memory.trim()}\n` : "";
  if (kind === "research") {
    return `You are investigating the user's OWN work / portfolio to surface job-search-relevant strengths, headless. Investigate the target (use WebFetch for URLs; read local files if referenced) and report: what it is, why it is impressive, and how to leverage it in their job search — which roles/claims it supports and how to frame it on a CV. Be specific, honest, and encouraging.${mem}

End with EXACTLY one final line: VERDICT: {0-5 signal strength}/5 — {why it helps their search, ≤12 words}

Target: ${input}`;
  }
  if (kind === "pdf") {
    return `You are generating the user's ATS-optimized, TAILORED CV PDF for application #${input}, headless, on their machine. Run the REAL career-ops "pdf" mode — follow modes/pdf.md EXACTLY (do not improvise a format).
1. Read modes/pdf.md, cv.md, config/profile.yml, and the evaluation report at reports/${input}-*.md (for the JD keywords + analysis).
2. Tailor the CV per modes/pdf.md: inject the JD's keywords into the summary + first bullets, reorder experience by relevance, build the competency grid, pick the top 3–4 projects. NEVER invent skills — only reword REAL experience using the JD's vocabulary.
3. Fill templates/cv-template.html's {{...}} placeholders with the tailored content; write the HTML to /tmp/cv-{candidate}-{company}.html (candidate = the profile name in kebab-case).
4. Render the PDF: \`node generate-pdf.mjs /tmp/cv-{candidate}-{company}.html output/cv-{candidate}-{company}-${today}.pdf --format={letter for US/Canada companies, else a4}\`.
5. Update the tracker: in data/applications.md, change the PDF column for row #${input} from ❌ to ✅.
Do not submit anything anywhere.

End with EXACTLY one final line: VERDICT: {5 if the PDF was written, else 1}/5 — {the output/ path, ≤12 words}`;
  }
  if (kind === "widen-watchlist") {
    const target = input.trim();
    return `You are widening career-ops' company watchlist (portals.yml), headless, on the user's own machine. This is the SAME real-verification standard used throughout this project's history — a company is only ever added with a CONFIRMED, LIVE, working config. Never guess a careers_url, never add a company with an unconfirmed ATS.

${target ? `Verify and (if confirmed) add exactly ONE company: "${target}".` : `Discover NEW candidate companies not already in portals.yml, using the domain already encoded in config/profile.yml (target_roles/narrative) — search recent (current year) analyst category pages (e.g. G2 category listings for the relevant software category) and recent funding-round news for companies in this space. Prioritize quality of verification over quantity of candidates found.`}

For each candidate company, verify in this order — real HTTP checks, not assumptions:
1. Greenhouse: try \`https://boards-api.greenhouse.io/v1/boards/{slug}/jobs\` for slug variants derived from the company name (lowercase, hyphenated, no-space) — a real JSON response with a non-empty "jobs" array confirms it.
2. Ashby: try \`https://api.ashbyhq.com/posting-api/job-board/{slug}\`.
3. Lever: try \`https://api.lever.co/v0/postings/{slug}?mode=json\`.
4. Workday: search for the company's real careers page, look for a \`{tenant}.{instance}.myworkdayjobs.com\` URL, then POST to \`https://{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs\` with body \`{"appliedFacets":{},"limit":5,"offset":0,"searchText":""}\` — a real response with a "total" count confirms it. IMPORTANT: even if the company's human-facing careers page looks like an empty JS shell with no visible links, the Workday API itself often still works independently of the page's own rendering — always test the API directly, never conclude "unscannable" from the page alone.
5. If none of the 4 resolve: fetch one real individual job-listing detail page (not the search/listing page) and check for \`<script type="application/ld+json">\` containing \`"@type":"JobPosting"\`. If found, also check whether the LISTING page itself has real server-rendered \`<a href>\` links to other job detail pages matching a consistent URL pattern — if so, this company can use \`provider: jsonld-jobposting\` with a \`job_link_pattern\` field (see providers/jsonld-jobposting.mjs's existing listing-discovery mode); if the listing page is a JS shell with no real links, only a single-page (one known posting) config is possible, or the company is genuinely unscannable this way.

For each CONFIRMED company, edit portals.yml directly: add a new entry under tracked_companies with careers_url, provider (and job_link_pattern/api if applicable), enabled: true, and a notes field following the exact convention already used throughout this file — cite what was confirmed and today's date. Preserve all other YAML structure, comments, and formatting exactly; touch ONLY the new entr(y/ies) you just verified.

Never add a company with an unconfirmed ATS, not even as a disabled placeholder with a guessed URL — if nothing resolves, just don't add it and say so in your final report.

End with EXACTLY one final line: VERDICT: {number of companies confirmed and added}/5 — {names added, or "none confirmed" and why, ≤20 words}`;
  }
  if (kind === "compute-heat") {
    const target = input.trim();
    return `You are computing company_heat signal scores (signal-agent/compute-heat.mjs) for career-ops, headless, on the user's own machine. Follow signal-agent/SKILL.md's real workflow EXACTLY — do not invent a different scoring method.

${target ? `Score exactly ONE company: "${target}".` : `Score every company that appears in data/relationships.md's Company column AND every \`enabled: true\` company in portals.yml that does NOT already have a record in data/company-signals.json (read it first to see what's already scored — don't re-score a company scored in the last 7 days, check its updatedAt).`}

For each company, in order:
1. Funding/news — WebSearch "{company} funding OR acquisition OR layoffs {current year}" and recent press. Score a 0-100 "funding" sub-score using this rubric: 0 = nothing found/no signal, 25 = old news only (>6mo), 50 = some recent activity, 75 = a recent funding round or notable growth news, 100 = major recent funding round or hiring surge announcement. Score 0 honestly if you found nothing — do not guess.
2. Reddit hiring chatter — WebSearch "{company} reddit hiring OR interview OR layoffs" — same 0/25/50/75/100 rubric applied to hiring-chatter evidence (0 = nothing found, 100 = strong recent chatter about active hiring).
3. LinkedIn hiring signal — WebSearch "{company} hiring" / recruiter posting cadence over the last 30 days — same rubric shape, applied to hiring-cadence evidence.
4. GitHub org activity — find the company's real GitHub org slug (WebSearch if not obvious), then run \`node signal-agent/compute-heat.mjs --company "{company}" --funding {N} --reddit {N} --linkedin {N} --github-org {org-slug}\` — this persists the record AND computes the GitHub sub-score itself via the GitHub API. If no GitHub org exists for this company, run the same command with \`--no-github\` instead of \`--github-org\`.

This command call is what actually writes to data/company-signals.json — do not write that file directly, always go through compute-heat.mjs so the composite math stays correct. It also AUTOMATICALLY computes a 5th "velocity" signal from data/scan-history.tsv (no flag needed, nothing for you to research) — the printed result may show \`velocityMeta.insufficientHistory: true\` if scan history isn't old enough yet for this company; that's an honest "not enough data," not a failure, and should be reported as such if you mention it.

End with EXACTLY one final line: VERDICT: {number of companies scored}/5 — {company: heat score pairs, ≤20 words}`;
  }
  if (kind === "contacto") {
    return `You are running the REAL career-ops "contacto" mode, headless, on the user's own machine — find real people to reach out to for a specific application, and draft outreach messages. Do NOT improvise a different approach.

1. Read modes/contacto.md and follow the "LinkedIn power move" flow EXACTLY (not the Greeting variant — this always has a specific application). Ground it in THIS person: read cv.md, config/profile.yml (including contact_preferences), and the evaluation report at reports/${input}-*.md for the company/role/JD context.
2. Use WebSearch to identify real candidate contacts: hiring manager, assigned recruiter, 2-3 team peers, interviewer (if scheduled). Never fabricate a name — if you can't find a real person for a slot, skip that slot and say so.
3. For EACH real person found, also capture how to actually reach them — this is REQUIRED, not optional. A name with no way to reach them is useless to the user:
   a. Their real LinkedIn profile URL (the actual https://www.linkedin.com/in/... URL from the search result, not a guessed slug).
   b. A real, publicly-verifiable email address IF one is genuinely discoverable (e.g., listed on the company's own team/directory page, their personal site, a conference bio, GitHub profile, a press mention). NEVER fabricate or pattern-guess an email (e.g., never assume firstname.lastname@company.com just because that's a common pattern) — an unconfirmed guessed email is worse than no email, since it looks real but may not work or may reach the wrong person. If no real email is found, leave it empty.
   If you can find the person by name/role/company but genuinely cannot find EITHER a LinkedIn URL or a real email, still add them but say so explicitly in your final report (do not silently omit the gap).
4. For each REAL person found, classify contact type and draft the message per modes/contacto.md's persona engine (≤300 chars, no corporate-speak, never share a phone number).
5. For each REAL person found, add them to the relationship tracker by running: \`node relationships.mjs --add --name "{Full Name}" --role "{their role/title}" --company "{Company}" --linkedin "{their real LinkedIn URL, or leave empty if genuinely not found}" --email "{their real verified email, or leave empty — NEVER a guessed pattern}" --notes "{contact type}: {the drafted message, verbatim}"\` — this is the ONLY way to persist a contact; never edit data/relationships.md directly.
6. NEVER send, submit, or click anything. This is research + draft-only — the user copies and sends manually themselves.

End with EXACTLY one final line: VERDICT: {number of real contacts found and added}/5 — {names + contact types, ≤20 words}

Application #: ${input}`;
  }
  if (kind === "fix-portal") {
    return `A company's job-portal ATS slug is BROKEN — career-ops can no longer scan it, so it silently disappears from every future scan. Repair it (headless, on the user's machine):
1. Run \`node verify-portals.mjs --add "${input}"\` — it probes Greenhouse/Ashby/Lever for the company's correct ATS slug and prints the suggested ats + slug.
2. Open portals.yml, find the "${input}" entry under tracked_companies, and update its careers_url (and any api/slug field) to the suggested WORKING ATS URL. Change ONLY this one company; preserve all other YAML structure, comments and formatting exactly.
3. Re-run \`node verify-portals.mjs\` and confirm "${input}" now shows ✅ live (not ❌).
If NO slug variant resolves, say so clearly and leave portals.yml unchanged. Never touch any other company.

End with EXACTLY one final line: VERDICT: {5 if now live, else 1}/5 — {what you changed, ≤12 words}`;
  }
  // evaluate (default) — run the REAL oferta mode + persist canonically
  return `You are running the OFFICIAL career-ops job evaluation, HEADLESS, on the user's own machine. Today is ${today}. Run the REAL career-ops evaluation — do NOT improvise your own scoring.

1. Read modes/oferta.md and follow it EXACTLY (blocks A–F, G posting-legitimacy, and the Machine Summary). Ground the fit in THIS person: read cv.md, config/profile.yml and modes/_profile.md. Use WebFetch to read the posting (you are headless — Playwright is unavailable, so use WebFetch and mark the report header "Verification: unconfirmed (batch mode)").

2. Persist the result CANONICALLY so the web and the CLI share ONE source of truth:
   a. Reserve a report number: run \`node reserve-report-num.mjs\` — its stdout is a 3-digit number (e.g. 035).
   b. Write the full report to reports/{num}-{company-slug}-${today}.md  (company-slug = company lowercased, non-alphanumerics → hyphens).
   c. Append ONE row of 9 TAB-separated columns to batch/tracker-additions/{num}-{company-slug}.tsv, in THIS exact order (real \\t tabs, status BEFORE score):
      {num}\t${today}\t{Company}\t{Role}\t{CanonicalStatus e.g. Evaluated}\t{score}/5\t❌\t[{num}](reports/{num}-{company-slug}-${today}.md)\t{one-line note}
   d. Merge into the tracker: run \`node merge-tracker.mjs\` (it dedupes by company+role+report-num, validates the status, and writes data/applications.md — NEVER edit applications.md by hand).

3. NEVER submit an application, fill no forms, contact no one. This is evaluation + persistence ONLY.${mem}

After everything above is written and merged, output EXACTLY one final line, nothing after it:
VERDICT: {score}/5 — {reason in 12 words or fewer}

Posting URL: ${input}`;
}

export async function POST(req: Request) {
  let body: { kind?: string; input?: string; cliId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  const { kind = "evaluate", input, cliId } = body;
  // widen-watchlist's and compute-heat's input is OPTIONAL — empty means
  // "discover new candidates" / "score everything stale" rather than a single
  // named target (see buildPrompt).
  const OPTIONAL_INPUT_KINDS = ["widen-watchlist", "compute-heat"];
  if ((!input && !OPTIONAL_INPUT_KINDS.includes(kind)) || !cliId) {
    return new Response(JSON.stringify({ error: "input and cliId required" }), { status: 400 });
  }
  const safeInput = input ?? "";
  const resolved = resolveCli(cliId);
  if (!resolved) {
    return new Response(JSON.stringify({ error: `CLI '${cliId}' not found` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;

  // These run the REAL core (modes/scripts), not just data — fail clearly if the
  // root is incomplete instead of faking it.
  const needsScript: Record<string, string> = { evaluate: "modes/oferta.md", "fix-portal": "verify-portals.mjs", "widen-watchlist": "verify-portals.mjs", "compute-heat": "signal-agent/compute-heat.mjs", contacto: "modes/contacto.md", pdf: "generate-pdf.mjs" };
  const required = needsScript[kind];
  if (required && !fs.existsSync(path.join(careerOpsRoot(), required))) {
    return new Response(
      JSON.stringify({
        error: `This needs a complete career-ops checkout (${required}). CAREER_OPS_ROOT has data only — point it at a full checkout.`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // An A–F score is meaningless without a CV to score against — the CLI would
  // hallucinate a fit narrative and still emit a VERDICT. Require cv.md first.
  if ((kind === "evaluate" || kind === "pdf") && !fs.existsSync(path.join(careerOpsRoot(), "cv.md"))) {
    return new Response(
      JSON.stringify({ error: "Add your CV first so I can score this against you — drop it on the home page." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildPrompt(kind, safeInput, readMemory(), today);

  const isClaude = cliId === "claude";
  // Tool scope by kind (comma-separated lists; disallowedTools is the hard
  // guardrail). 'evaluate' runs the REAL mode + persists canonical artifacts →
  // it needs Write + Bash (reserve-report-num / merge-tracker / write the
  // report). 'research' stays read-only. Task (sub-agents) is always blocked
  // (runaway cost). NEVER auto-submits — that is a prompt-level guarantee.
  const tools =
    kind === "evaluate" || kind === "fix-portal" || kind === "widen-watchlist" || kind === "compute-heat" || kind === "contacto" || kind === "pdf"
      ? { allowed: "Read,WebFetch,WebSearch,Write,Edit,Bash,Glob,Grep", disallowed: "Task,NotebookEdit" }
      : { allowed: "Read,WebFetch,WebSearch,Glob,Grep", disallowed: "Bash,Write,Edit,NotebookEdit,Task" };
  const args = isClaude
    ? ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
       "--permission-mode", "acceptEdits",
       "--allowedTools", tools.allowed,
       "--disallowedTools", tools.disallowed]
    : spec.args(prompt);

  // For write-needing kinds, snapshot reports/ so we can verify the worker
  // actually persisted (non-Claude CLIs lack Write auth and silently no-op).
  const reportsDir = path.join(careerOpsRoot(), "reports");
  const countReports = () => {
    try {
      return fs.readdirSync(reportsDir).filter((f) => f.endsWith(".md")).length;
    } catch {
      return 0;
    }
  };
  const persists = kind === "evaluate";
  const reportsBefore = persists ? countReports() : 0;
  // Tracker-mutating runs hold a write token so a row delete can't race their merge
  // (tracker.mjs delete doesn't yet share a lock with merge-tracker — see run-registry).
  const writeToken = kind === "evaluate" || kind === "pdf" ? acquireTrackerWrite() : null;

  const child = spawn(binPath, args, { cwd: careerOpsRoot(), env: process.env });
  const enc = new TextEncoder();

  // `closed` + kill timer in the OUTER scope so cancel() (client disconnect) can
  // flip `closed` before the child's late handlers run, and send() is try/catch'd —
  // otherwise a late enqueue onto a closed controller throws uncaught (see #1155).
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emittedText = false; // any assistant text delta → the CLI actually ran
      let sawError = false;
      let lastTokens = 0; // per-run token cost from the Claude result event (#6) — local only
      let lastCostUsd: number | null = null;
      // pdf-mode tailors a full CV + renders it — give it more headroom.
      const killMs = kind === "pdf" ? 720_000 : 285_000;
      killer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, killMs);
      const send = (obj: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + "\n")); } catch { closed = true; }
      };
      const close = () => {
        if (!closed) {
          closed = true;
          if (killer) clearTimeout(killer);
          if (writeToken !== null) releaseTrackerWrite(writeToken);
          try { controller.close(); } catch { /* */ }
        }
      };

      child.stdout.on("data", (d: Buffer) => {
        if (closed) return;
        if (!isClaude) {
          emittedText = true;
          send({ type: "text", text: d.toString() });
          return;
        }
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === "stream_event") {
              const e = ev.event;
              if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
                send({ type: "tool", name: e.content_block.name });
              } else if (e?.type === "content_block_delta" && e.delta?.text) {
                emittedText = true;
                send({ type: "text", text: e.delta.text });
              }
            } else if (ev.type === "system" && ev.subtype === "init") {
              send({ type: "status", label: "Agent ready" });
            } else if (ev.type === "result") {
              // Capture the per-run cost; the authoritative "done" is sent on close
              // (so the honesty gate decides done-vs-error first). Tokens = the same
              // formula /api/usage uses: input + output + cache-creation.
              const u = ev.usage || {};
              lastTokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
              if (typeof ev.total_cost_usd === "number") lastCostUsd = ev.total_cost_usd;
            }
          } catch {
            /* partial line */
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        // Widened: auth/login/quota failures are the most common real error and
        // the old narrow regex missed them (silent false "success").
        if (/error|denied|fatal|not found|unauthorized|forbidden|auth|login|credential|api[ -]?key|quota|rate limit|not authenticated/i.test(s)) {
          sawError = true;
          send({ type: "error", msg: s.trim().slice(0, 200) });
        }
      });
      child.on("error", (e) => { send({ type: "error", msg: e.message }); close(); });
      child.on("close", (code) => {
        const wroteReport = countReports() > reportsBefore;
        const cleanExit = code === 0; // non-zero OR null (killed/signal) = NOT clean
        // Honesty gate (#9): a green "done" with a parsed score requires a CLEAN exit,
        // real output, AND (for evaluations) a report actually written. Anything else
        // is surfaced — an errored run must never be banked as a confident score.
        if (!emittedText && !sawError && !cleanExit) {
          send({ type: "error", msg: "The CLI exited with an error — is it installed and authenticated?" });
        } else if (!emittedText && !sawError) {
          send({ type: "error", msg: "The CLI produced no output — is it installed and authenticated? (career-ops is best on Claude Code.)" });
        } else if (persists && !wroteReport) {
          // The worker ran but never wrote the report/tracker row (e.g. a CLI
          // without file-write authorization) — surface it instead of a fake score.
          send({ type: "error", msg: "This evaluation didn't save a report, so it's not in your tracker. Full evaluation is verified on Claude Code." });
        } else if (!cleanExit || sawError) {
          // Produced output (maybe even a report) but did NOT finish cleanly — flag it
          // instead of recording a confident score off a half-finished run.
          send({ type: "error", msg: "This run hit an error before finishing, so it isn't recorded as a confident result — re-run it to verify." });
        } else {
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
        }
        close();
      });
    },
    cancel() {
      closed = true;
      if (killer) clearTimeout(killer);
      if (writeToken !== null) releaseTrackerWrite(writeToken);
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
