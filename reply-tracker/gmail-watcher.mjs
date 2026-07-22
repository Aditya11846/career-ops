#!/usr/bin/env node
/**
 * reply-tracker/gmail-watcher.mjs — Gmail OAuth watcher for application replies
 *
 * Closes #1583, the gap paste-reply.mjs's own header names explicitly: "the
 * only planned way to populate data/reply-candidates.json is a Gmail
 * scanner (#1583, unbuilt, requires OAuth inbox-read access)." This is that
 * scanner.
 *
 * Reuses plugins/gmail/index.mjs's OAuth token-refresh pattern
 * (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN via .env, POST to
 * https://oauth2.googleapis.com/token) and its _helpers.mjs utilities
 * (isAuthenticEmail for DMARC fail-closed, getMessageBody for base64 body
 * decoding) — but NOT that plugin's ingest-into-pipeline.md logic. That
 * plugin does a different job entirely: it scans a label for NEW job leads
 * and returns Job[] for plugins.mjs to write into data/pipeline.md. This
 * watcher scans the inbox generally for REPLIES to applications already
 * sent, and writes into data/reply-candidates.json in the exact schema
 * reply-matcher.mjs's classifyReply()/matchCandidates() expect:
 *   { message_id, from, subject, body_snippet, signal }
 * `signal` is always left null — classification is reply-watch.mjs's job
 * (via reply-matcher.mjs), not this watcher's, matching paste-reply.mjs's
 * own documented convention.
 *
 * Writes go through paste-reply.mjs's appendCandidate() — the one shared,
 * now-locked writer of reply-candidates.json (tracker-utils.mjs's
 * acquireTrackerLock/writeFileAtomic) — so this watcher and paste-reply.mjs
 * can run concurrently without corrupting the file.
 *
 * Dedupe: keeps its own processed-message-id cursor at
 * data/gmail-reply-state.json (deliberately separate from the ingest
 * plugin's data/gmail-state.json — different query/purpose, different
 * cursor) so repeat runs never reprocess the same email twice.
 *
 * Query: by default scans the whole inbox (no label required) for messages
 * newer than `--days-back` (default 14) that look like a reply — i.e. NOT
 * ones you sent yourself (`-from:me`) — narrowed further, optionally, by
 * `--label <name>` if the user files application-related mail into a label.
 *
 * Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (same vars
 * plugins/gmail/index.mjs uses — set once, shared by both).
 *
 * Usage:
 *   node reply-tracker/gmail-watcher.mjs [--days-back 14] [--label "Applications"] [--dry-run]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isAuthenticEmail, getMessageBody } from '../plugins/gmail/_helpers.mjs';
import { appendCandidate } from '../paste-reply.mjs';

const CAREER_OPS = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_PATH = process.env.CAREER_OPS_GMAIL_REPLY_STATE || join(CAREER_OPS, 'data/gmail-reply-state.json');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Exchange the long-lived refresh token for a short-lived access token. */
async function getAccessToken({ clientId, clientSecret, refreshToken }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Gmail token refresh failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Gmail token refresh returned no access_token');
  return data.access_token;
}

function loadProcessedIds() {
  if (!existsSync(STATE_PATH)) return new Set();
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    return new Set(state.processed_message_ids || []);
  } catch {
    return new Set();
  }
}

function saveProcessedIds(ids) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ processed_message_ids: [...ids] }, null, 2), 'utf-8');
}

function parseArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function headerValue(headers, name) {
  return headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

/**
 * Scan Gmail for candidate reply emails and append normalized candidates via
 * paste-reply.mjs's shared, locked appendCandidate(). Returns a summary.
 * Exported for direct testing (mock `deps` to avoid real network calls).
 */
export async function runWatcher({ daysBack = 14, label = null, dryRun = false } = {}, deps = {}) {
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const env = deps.env || process.env;

  const clientId = env.GMAIL_CLIENT_ID;
  const clientSecret = env.GMAIL_CLIENT_SECRET;
  const refreshToken = env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('gmail-watcher: missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN in .env');
  }
  if (!Number.isInteger(daysBack) || daysBack <= 0) {
    throw new Error(`gmail-watcher: invalid daysBack "${daysBack}" (must be a positive integer)`);
  }

  const token = await getAccessToken({ clientId, clientSecret, refreshToken }, fetchFn);
  const auth = { Authorization: `Bearer ${token}` };

  const queryParts = [`-from:me`, `newer_than:${daysBack}d`];
  if (label) queryParts.unshift(`label:"${label}"`);
  const query = queryParts.join(' ');

  const messages = [];
  let pageToken = null;
  do {
    let url = `${GMAIL_API}/messages?q=${encodeURIComponent(query)}`;
    if (pageToken) url += `&pageToken=${pageToken}`;
    const res = await fetchFn(url, { headers: auth });
    if (!res.ok) throw new Error(`gmail-watcher: list failed ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    if (data.messages) messages.push(...data.messages);
    pageToken = data.nextPageToken;
  } while (pageToken);

  const processedIds = loadProcessedIds();
  const appended = [];
  const skippedSpoofed = [];
  const skippedErrors = [];

  for (const m of messages) {
    if (processedIds.has(m.id)) continue;

    let msg;
    try {
      const res = await fetchFn(`${GMAIL_API}/messages/${m.id}?format=full`, { headers: auth });
      if (!res.ok) throw new Error(`fetch failed ${res.status}`);
      msg = await res.json();
    } catch (err) {
      skippedErrors.push({ id: m.id, error: err.message });
      continue;
    }

    const headers = msg.payload?.headers || [];
    const subject = headerValue(headers, 'subject');
    const from = headerValue(headers, 'from');

    if (!isAuthenticEmail(headers)) {
      skippedSpoofed.push({ id: m.id, subject });
      processedIds.add(m.id);
      continue;
    }

    const bodySnippet = getMessageBody(msg.payload).slice(0, 2000);
    const candidate = {
      message_id: m.id,
      from,
      subject,
      body_snippet: bodySnippet,
      signal: null,
    };

    if (!dryRun) {
      await appendCandidate(candidate);
    }
    appended.push(candidate);
    processedIds.add(m.id);
  }

  if (!dryRun) saveProcessedIds(processedIds);

  return {
    query,
    scanned: messages.length,
    appended: appended.length,
    skippedSpoofed: skippedSpoofed.length,
    skippedErrors: skippedErrors.length,
    candidates: appended.map(c => ({ message_id: c.message_id, from: c.from, subject: c.subject })),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const daysBack = Number(parseArg(args, '--days-back') ?? 14);
  const label = parseArg(args, '--label') || null;
  const dryRun = args.includes('--dry-run');

  const result = await runWatcher({ daysBack, label, dryRun });
  console.log(JSON.stringify(result, null, 2));
}

// Guarded so runWatcher() is safely importable (e.g. for testing) without
// triggering the CLI's real Gmail call as an import side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
