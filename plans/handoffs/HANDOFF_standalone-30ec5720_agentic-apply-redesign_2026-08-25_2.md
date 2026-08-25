# Agentic apply redesign (cont.): handoff finalized, no code changes since seq 1

**Date:** 2026-08-25
**Status:** IN PROGRESS
**Bead(s):** none
**Epic:** none
**Chain:** `standalone-30ec5720` seq `2`
**Parent:** `HANDOFF_standalone-30ec5720_agentic-apply-redesign_2026-08-25.md`
**Prior chain:** `HANDOFF_standalone-30ec5720_agentic-apply-redesign_2026-08-25.md` > this

---

## Since Last Handoff

The parent (seq 1) was written at the user's first `/handoff`, then the user ran `/handoff` again instead of answering the close-session question. **No code, test, or runtime state changed between the two invocations.** What happened since the parent:

- The seq 1 handoff file itself was created (399 lines) at `plans/handoffs/HANDOFF_standalone-30ec5720_agentic-apply-redesign_2026-08-25.md`.
- Memory persisted: `bd remember` pointer + new auto-memory file `~/.claude/projects/-Users-adium-career-ops/memory/project_agentic_apply_redesign.md` + one-line index entry in `MEMORY.md`.
- `plans/` is now untracked in git (`?? plans/`) — the handoff directory itself is new to the repo.
- **Trajectory: unchanged.** Still 10 modified + 2 new source files, all uncommitted; still blocked on Gmail OAuth; dev server still the background task (log `/tmp/nextdev.log`); Broadcom real-site test still the in-flight next action.

No open questions from the parent were answered; no risks materialized or resolved.

---

## Reference Documents

- **READ THE PARENT FIRST for full detail** — `plans/handoffs/HANDOFF_standalone-30ec5720_agentic-apply-redesign_2026-08-25.md` (399 lines: complete What We Tried, Key Decisions, Evidence tables, Code Analysis, verbatim agentic prompt + temp mcp-config + hybrid action enum, real-website testing playbook, GitNexus compliance note, glossary).
- `/Users/adium/.claude/plans/crystalline-yawning-seahorse.md` — the design plan this work implements.
- `web/src/lib/apply/secret-mcp-server.ts` — the new secret MCP server (full read in prior transcript).

---

## The Goal

(Identical to parent — abbreviated.) Implement the agentic apply redesign: one genuine multi-turn Claude Code session per apply attempt, driving the live browser via **Playwright MCP over CDP** (attached to the exact page `session.ts` opened) plus a **private stdio MCP server** that fills secrets into the focused field so values never enter the model's context. Model decides login-vs-signup-vs-form from real `browser_snapshot`/tools; `signal_reached_application_form` / `signal_blocked(reason)` are the terminal-state tool calls. Standing directive: **test on the real `/apply` website, iterate until 10 applications pass end-to-end, learn from every failure, fire subagents if needed, full autonomy, keep git pushing.** Approval gate intact (nothing filled/submitted without explicit prior approval).

---

## Current State (verified at seq 2, 2026-08-25 ~12:55)

### Working tree (all uncommitted — this is the #1 pending action)

| File | Δ | Purpose |
|---|---|---|
| `web/src/lib/apply/live-agent.ts` | +262 | agentic path (`runAgenticReach`, `writeAgenticMcpConfig`, `readAgentSignal`, `buildAgenticPrompt`), 3-state `CredState`, `wait_for_page`, password fallback, `MAX_STEPS` 15→45 |
| `web/src/lib/apply/agent-interpret.ts` | +60 | `PlannerOpts`, `buildClaudeArgs`, `runPlanner` opts, timeout 150s→300s |
| `web/src/lib/apply/ats-account.ts` | +49 | `actuateLocator` factored out; `actuateField` delegates |
| `web/src/components/apply/apply-provider.tsx` | +45 | async self-healing `resolveCliId()` |
| `web/src/lib/apply/session.ts` | +38 | `pickFreePort` / `getCdpPort` / `--remote-debugging-port` launch arg |
| `web/src/app/api/apply/prefill/route.ts` | +13 | `resolveEffectiveCli` |
| `web/src/lib/clis.ts` | +12 | `resolveEffectiveCli(requested?)` (server-authoritative CLI selection) |
| `web/src/app/api/apply/{session,drive}/route.ts` | +7/+6 | `resolveEffectiveCli` |
| `package.json` | +1 | `@modelcontextprotocol/sdk@^1.30.0` (possibly **unused** — verify/remove) |
| `web/src/lib/apply/secret-mcp-server.ts` | NEW | 347-line stdio MCP server (untracked) |
| `setup-gmail-oauth.mjs` | NEW | OAuth installed-app flow → writes 3 env vars to `.env` (untracked) |
| `plans/` | NEW | handoff dir (untracked) |

### Runtime / verification state

- **Dev server:** running as background task; healthy (`/api/version` → 200). Log: `/tmp/nextdev.log`.
- **Proof-of-flow (1 real test, Trellix Workday):** `POST /api/apply/session 200 in 27.5s` → `POST /api/apply/drive 200 in 75s`. Agentic session ran, correctly hit account-creation → `await_verification_email` → **genuine, specific blocked reason** surfaced through the UI. Control flow, tool wiring, and terminal-state reporting all proven live.
- **Hard gate:** `.env` lacks `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN`. Email-verification-gated signups cannot complete until a human runs `setup-gmail-oauth.mjs`.
- **Not yet done:** `npm run build` (typecheck); a genuine `signal_reached_application_form` success; CrowdStrike re-run; Broadcom re-run (started, interrupted).
- **Cleanup verified:** no leftover `data/ats-mcp-*.json` / `data/ats-agent-result-*.json` (temp files deleted in `finally`).

---

## What We Tried — abbreviated (full detail in parent)

1. **2026-08-24 CrowdStrike hybrid failure** (root cause of redesign): one-shot model over our DOM candidate list, zero tools → guessed `blocked` on an empty render; a second run died at step 15 on unparseable CLI output.
2. **Architecture research** → `crystalline-yawning-seahorse.md` (Playwright MCP `--cdp-endpoint` + two-layer MCP strategy confirmed viable).
3. **`secret-mcp-server.ts`** scaffolded (hand-rolled stdio MCP, erasable-TS-only, `document.activeElement` fill contract, env-only secrets).
4. **`session.ts` CDP wiring** (`pickFreePort`/`getCdpPort`, `--remote-debugging-port` launch arg).
5. **`runAgenticReach()`** replaces hybrid loop for claude; hybrid kept for codex/gemini (no MCP tool-loop story).
6. **`runPlanner` extended** (`PlannerOpts`/`buildClaudeArgs`; timeout 150s→300s).
7. **`actuateLocator` factored** out of `ats-account.ts`.
8. **CLI-selection bug fixed** (`resolveEffectiveCli` + client self-heal) — empty localStorage cliId was silently disabling the agentic loop (S207).
9. **Dev-server wedge** (~12:30): hung `POST /api/apply/session`, server totally unresponsive, permission system refused un-authorized `kill`; user "wtf are you doing"; killed 1191+1192 after explanation, clean restart via `nohup`; identical re-test passed. Root cause never found (read as one-off wedge).
10. **Trellix real-site re-test** → genuine blocked-state report (Gmail gap). First live proof of agentic flow.
11. **Gmail OAuth gap** → wrote `setup-gmail-oauth.mjs` (unrun; human consent step).
12. **Broadcom test started** (interrupted by `/handoff`).

---

## Key Decisions (full rationale in parent)

claude-only agentic v1 · `bypassPermissions` scoped by allow/disallow lists · secrets never in model context (env + temp config, deleted) · `--bare` CLI · terminal state via signal file not stdout · `document.activeElement` fill contract · 3-state credentials · server-authoritative CLI resolution · `candsLookLikeApplication` narrowed to input-like elements · `wait_for_page` 3s pause.

---

## Evidence & Data (pointers — full tables in parent)

- `/tmp/nextdev.log` — dev-server request timings (session 27.5s, drive 75s).
- `data/ats-account-log.jsonl` — per-run account-step trace (2026-08-24 CrowdStrike failure + 2026-08-25 Trellix blocked-with-Gmail-reason).
- `data/ats-credentials/{broadcom,crowdstrike,trellix}.json` — account-creation attempts with `[REDACTED]`.
- Memory trail: claude-mem obs #584, #617-627, #628-656 (parent has full list).

---

## User Feedback & Preferences (from this chain, verbatim)

- **"wtf are you doing and why is it stuck"** — terse frustration at dev-server hang; proceed after a plain explanation, don't stall on deliberation.
- **"and keep git pushing"** — commit AND push continuously. **The working tree is still uncommitted — do this first.**
- **"no manual bullshit"** — verify through the real `/apply` website, never hand-rolled Node scripts.
- **Loop directive** — don't stop until 10 applications pass end-to-end; don't stop on "looks done"; learn from every failure; subagents/new sessions allowed; full autonomy.
- **Approval gate sacred** (AGENTS.md) — nothing filled/submitted without explicit prior approval.
- **Web-first, Amit is the consumer** — never push work back onto Amit; 24/7 autonomous.

---

## Where We're Going (unchanged from parent)

1. **Commit + push** the working tree (user explicitly asked). Run GitNexus `impact`/`detect_changes` first per CLAUDE.md (wasn't done during implementation).
2. **Unblock Gmail OAuth** — hand `setup-gmail-oauth.mjs` to the human (Aditya/Amit, whoever owns `[REDACTED]`): create Google Cloud OAuth Desktop client (enable Gmail API; redirect `http://127.0.0.1:53682/oauth2callback`), run script, approve, restart dev server.
3. **Finish the in-flight Broadcom test** via `/apply` (`https://broadcom.wd1.myworkdayjobs.com/External_Career/job/USA-TX-Plano-Legacy-Drive-Suite-700/Cyber-Security-Engineer_R026429`).
4. **Re-run CrowdStrike** (original failure case) via `/apply`.
5. **Iterate to 10 end-to-end passes**; diagnose each failure from `/tmp/nextdev.log` + `data/ats-account-log.jsonl` + UI reason; patch; re-run.
6. **`npm run build`** on `web/` (task #6 still open).
7. **Verify password never leaks** into CLI JSON output or `data/ats-agent-trace.jsonl`.
8. **Follow-up (documented, out of scope):** apply the same CDP+Playwright-MCP treatment to `drive.ts`.

---

## Risks & Blockers

- **Gmail OAuth = hard human-in-the-loop gate** — every email-verification ATS (Workday tenants: Trellix, CrowdStrike) blocks at account creation until configured. Biggest blocker to the 10-passes goal.
- **Only `blocked` terminal state observed live** — genuine `reached` path (creds → `active`, fast-login next run) untested.
- **Dev-server wedge recurred once, root cause unknown** — don't force-kill processes you didn't start without authorization (permission precedent).
- **Production build never run** on redesigned code.
- **`@modelcontextprotocol/sdk` may be dead weight.**

---

## Open Questions

- Reproducible dev-server wedge or one-off? (No stack trace captured.)
- Does `await_verification_email` work against the real Workday verification email once Gmail is configured?
- Does a genuine `reached` run promote creds to `active` + enable fast-login?
- Does the agentic CLI reliably emit `"total_turns":N` (or does the UI usually show the "1 step" fallback)?
- Which Workday/other ATS flows DON'T require email verification (to test before Gmail)? Broadcom was being probed for this.

---

## Quick Start for Next Session

```bash
# Dev server
curl -s -m 5 http://localhost:3000/api/version -o /dev/null -w "%{http_code}\n"   # expect 200
tail -f /tmp/nextdev.log

# READ FIRST (in this order)
plans/handoffs/HANDOFF_standalone-30ec5720_agentic-apply-redesign_2026-08-25.md   # PARENT — full detail (399 lines)
cat /Users/adium/.claude/plans/crystalline-yawning-seahorse.md                    # design plan + verification checklist
web/src/lib/apply/live-agent.ts      # runAgenticReach / writeAgenticMcpConfig / readAgentSignal
web/src/lib/apply/secret-mcp-server.ts
web/src/lib/apply/session.ts         # pickFreePort / getCdpPort / headedBrowser CDP arg
setup-gmail-oauth.mjs

# Evidence
data/ats-account-log.jsonl           # outcome source of truth
data/ats-credentials/{broadcom,crowdstrike,trellix}.json

# Verify current state
git status                            # 11 modified/new + plans/ — ALL UNCOMMITTED

# Next action
# 1) COMMIT + PUSH (user: "and keep git pushing").
# 2) Hand the user setup-gmail-oauth.mjs for the one-time Gmail consent flow.
# 3) Finish the in-flight Broadcom test via http://localhost:3000/apply
#    (https://broadcom.wd1.myworkdayjobs.com/External_Career/job/USA-TX-Plano-Legacy-Drive-Suite-700/Cyber-Security-Engineer_R026429)
#    then re-run CrowdStrike. Loop until the flow genuinely passes end-to-end
#    (10 applications) — never stopping on "looks done".
```
