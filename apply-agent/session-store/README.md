# session-store/ — persistent Tier 2 login state

This directory holds Playwright `storageState` snapshots (cookies +
localStorage) for LinkedIn/Naukri, so Tier 2 reuses Aditya's real logged-in
session instead of opening a fresh, logged-out browser context every run.
`web/src/lib/apply/session.ts`'s `openSession()` accepts an optional
`storageStatePath`; `/api/apply/session` resolves it from here when the
request includes `platform: "linkedin" | "naukri"`.

## Setup

```
node apply-agent/session-store/login.mjs linkedin
node apply-agent/session-store/login.mjs naukri
```

**Prerequisite:** log into LinkedIn (or Naukri) in your normal, everyday
Chrome first — the regular way, no automation involved. Close Chrome before
running the command above.

**Why this way, not an automated login form:** LinkedIn and Google detect
Playwright-controlled Chrome via CDP (regardless of headed/headless) and hard
block sign-in with "this browser or app may not be secure." That's a
legitimate anti-automation control — this script does not attempt to
disguise around it. Instead it copies your real Chrome profile (excluding
cache/extensions, to a throwaway temp copy — never your live profile
directly, since Chrome locks a profile to one running instance), opens the
copy in a visible browser to confirm you're already logged in, saves just
that site's session cookies to `{platform}.json`, then deletes the profile
copy. No login flow is ever automated; the session is entirely one you
established yourself, the normal way.

Sessions expire eventually — if Tier 2 starts hitting `login-wall` again
after previously working, log in again in your normal Chrome and re-run the
command for that platform.

This file tree is gitignored (`*.json` and `.profile-copy-*/`) — session
cookies never get committed or synced between machines (job-search-automation
plan, Phase 5).
