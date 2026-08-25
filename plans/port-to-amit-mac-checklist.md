# Port to Amit's MacBook — Readiness Checklist

**Status:** READY TO EXECUTE (as of 2026-08-25)
**One-time move:** all further career-ops development moves to Amit's Mac; this Mac stays as an untouched backup.

---

## Repo state (this Mac — done ✅)

- [x] All work committed + pushed to `origin/main` (incl. agentic-apply redesign commit `7899337`)
- [x] Working tree clean, `0 ahead / 0 behind origin/main`
- [x] **PII purge:** `.claude/notes/config-snapshots/` (full CV, profile email+phone, real recruiter/peer contacts with drafted outreach) removed from the tracked tree + gitignored; ATS signup email scrubbed from the 2 handoff files
- [x] Pipeline health: `0 errors, 28 warnings` (duplicate/orphan reports — cosmetic)
- [x] `doctor.mjs --json` → `onboardingNeeded: false`

> ⚠️ **History note:** the PII was pushed in earlier commits (`9fc068e`, …`7899337`). Removing it from the current tree does **not** purge history. Full removal = `git filter-repo` + force-push — deferred, optional.

> ⏸️ **Update deferred:** upstream `1.26.0 → 1.29.0` available. Decision: port first, then run `node update-system.mjs` on Amit's Mac.

## Personal-data bundle (AirDrop — both Macs physically together)

Copy these gitignored files/folders as-is (they do NOT come from the git clone):

| Path | Notes |
|---|---|
| `cv.md` | canonical CV |
| `config/profile.yml` | profile + spend_tier |
| `portals.yml` | scan config |
| `data/` | entire dir: applications.md, pipeline.md, ats-credentials/, archive/, signals, etc. |
| `reports/` | all evaluation reports |
| `output/` | generated CV PDFs/HTML |
| `interview-prep/` | story-bank + per-company intel |
| `writing-samples/` | samples |
| `modes/_profile.md` | user archetypes/targeting |
| `modes/_custom.md` | procedural rules |
| `modes/_brief.md` | personal brief |
| `.env` | **does not exist yet** — nothing to AirDrop. Created on Amit's Mac by running `setup-gmail-oauth.mjs` (Gmail consent flow) when email-verification ATS flows are needed |
| `.claude/notes/config-snapshots/` | local-only recovery copies (now gitignored) — optional |

## Claude Code memory files (copy, not git)

1. Source: `~/.claude/projects/-Users-adium-career-ops/memory/*.md` on this Mac
2. Destination: the new project's memory dir once Amit's project absolute path is known (`/Users/amit/career-ops` → a *different* folder name than this Mac's)
3. Copy all `.md` files + `MEMORY.md` index

## On Amit's Mac — execution steps

1. **GitHub auth** (git/Node already installed): `gh auth login` or git credential setup
2. `git clone https://github.com/Aditya11846/career-ops.git` — code only; origin is public, nothing personal goes through it
3. `npm install` at repo root **and** in `web/` (node_modules rebuilt, never copied)
4. **AirDrop** the personal-data bundle above
5. **Copy** Claude Code memory `.md` files into the new project's memory path
6. **Claude Code login** — fresh account login (Amit's own account), NOT a copy of this Mac's `~/.claude`
7. **Reinstall user-level skills/plugins fresh** (account-scoped — do not copy files):
   - Skills: `agent-reach`, `excalidraw-diagram`, `find-skills`, `handoff`, `handoffplan`, `token-goat`
   - Plugins: `vercel` (from `anthropics/claude-plugins-official`), `claude-mem` (from `thedotmack/claude-mem`)
   - ✅ Project-level skills (`career-ops`, `gitnexus`) + project `.mcp.json` (gitnexus + playwright) travel with the git clone — no action
8. Fresh Claude Code session → `node doctor.mjs --json` → confirm `onboardingNeeded: false`
9. `node update-system.mjs check` → apply `1.29.0` (deferred decision)
10. `node verify-pipeline.mjs` → confirm health

## Post-port

- This Mac: **backup only**, not decommissioned
- Agentic apply redesign is **IN PROGRESS** — continues on Amit's Mac:
  - Gmail OAuth unconfigured (run `setup-gmail-oauth.mjs` once)
  - Broadcom + CrowdStrike re-tests via `/apply`
  - `npm run build` on `web/`
  - Iterate to 10 end-to-end passes
