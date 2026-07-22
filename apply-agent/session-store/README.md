# session-store/ — persistent Tier 2 login state (not yet wired)

This directory will hold Playwright `storageState` snapshots (cookies +
localStorage) for LinkedIn/Naukri, so Tier 2 can reuse Aditya's real logged-in
session instead of opening a fresh, logged-out browser context every run.

**Status: not implemented yet.** `apply-agent/tier2/driver-core.mjs` currently
opens sessions via the same `/api/apply/session` route Tier 1 uses, which
starts a clean context every time — so a real LinkedIn/Naukri URL correctly
hits the `login-wall` pause trigger and routes to `needs-input` today, rather
than failing silently.

**Never enter LinkedIn/Naukri credentials on the user's behalf.** Wiring this
requires: (1) `session.ts`'s `openSession()`/`headedBrowser()` gaining an
optional `storageState` path, (2) the user logging in ONCE, manually, in the
headed browser themselves, (3) Playwright's `context.storageState()` saving
that state here. This file tree is gitignored — session cookies never get
committed or synced between machines (job-search-automation plan, Phase 5).
