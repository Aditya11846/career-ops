#!/usr/bin/env node
/**
 * snapshot-config.mjs — dated, git-trackable backups of the gitignored
 * personal-data files (portals.yml, cv.md, config/profile.yml).
 *
 * These three are intentionally gitignored (personal data), which means they
 * have NO git history at all -- an edit gone wrong (e.g. a bad portals.yml
 * change) can't be diffed or reverted like everything else in this repo.
 * This script copies them into .claude/notes/config-snapshots/ under names
 * that DON'T match the gitignore patterns (which are bare filenames like
 * "cv.md" / "portals.yml" and match anywhere in the tree), so the copies get
 * committed normally and become a real, diffable, revertible history.
 *
 * Not automatic -- run it deliberately before/after a change worth being
 * able to undo, then `git add .claude/notes/config-snapshots/ && git commit`.
 *
 * Usage:
 *   node snapshot-config.mjs
 */

import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(ROOT, '.claude/notes/config-snapshots');
const DATE = new Date().toISOString().slice(0, 10);

const FILES = [
  { src: 'portals.yml', name: `portals-${DATE}.yml` },
  { src: 'cv.md', name: `cv-${DATE}.md` },
  { src: 'config/profile.yml', name: `profile-${DATE}.yml` },
  { src: 'data/relationships.md', name: `relationships-${DATE}.md` },
];

if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });

let copied = 0;
for (const { src, name } of FILES) {
  const srcPath = join(ROOT, src);
  if (!existsSync(srcPath)) {
    console.log(`skip: ${src} not found`);
    continue;
  }
  copyFileSync(srcPath, join(SNAPSHOT_DIR, name));
  console.log(`snapshotted: ${src} -> .claude/notes/config-snapshots/${name}`);
  copied += 1;
}

if (copied > 0) {
  console.log(`\n${copied} file(s) snapshotted. Commit them: git add .claude/notes/config-snapshots/ && git commit -m "Snapshot config ${DATE}"`);
}
