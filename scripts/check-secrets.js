#!/usr/bin/env node
// scripts/check-secrets.js
//
// Scans the working tree for things that must never land in this (public) repo:
// live-looking OAuth/API tokens, non-empty secret-shaped config values, Indian
// GSTIN/PAN/mobile-number patterns, real-looking email addresses, and absolute
// paths that leak a local Windows username.
//
// Usage: node scripts/check-secrets.js [rootDir]
// Exit code: 1 if anything is found, 0 if clean. Never prints the matched value —
// only "file:line:KIND" plus a masked preview.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.argv[2] ?? process.cwd());

// Directories never scanned, anywhere in the tree (runtime data, VCS internals, deps).
const SKIP_DIRS = new Set(['node_modules', '.git', 'var', 'data']);

// Binary / non-text extensions we don't attempt to scan as text.
const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.db', '.sqlite', '.sqlite3',
  '.woff', '.woff2', '.ttf', '.eot', '.zip', '.gz', '.lock',
]);

// This rule (secret-shaped config keys) is expected to be non-empty in real deployments but must
// stay empty/placeholder in anything committed. These two file shapes are documented templates.
function isTemplateConfigFile(relPath) {
  const base = path.basename(relPath);
  return base === '.env.example' || /\.example\.json$/.test(base);
}

// The three CLAUDE/CODEX/context planning prompts at repo root legitimately discuss things like
// "email the finance lead" or reference an illustrative address/IP as prose, not as project data.
// Documented, narrow allowlist: only EMAIL / WINDOWS_PATH kinds are excused, only in these files.
const PROMPT_DOC_ALLOWLIST = new Set([
  'CLAUDE_IMPLEMENTATION_PROMPT.md',
  'CODEX_MASTER_PROMPT.md',
  'PROJECT_CONTEXT.md',
]);
const PROMPT_DOC_ALLOWED_KINDS = new Set(['EMAIL', 'WINDOWS_PATH']);

function isAllowlisted(relPath, kind) {
  return PROMPT_DOC_ALLOWLIST.has(path.basename(relPath)) && PROMPT_DOC_ALLOWED_KINDS.has(kind);
}

/** Mask a matched value: keep first 2 / last 2 chars, blank the middle. Never print the raw value. */
function mask(value) {
  const s = String(value);
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(3, s.length - 4))}${s.slice(-2)}`;
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (SKIP_EXTS.has(ext)) continue;
    out.push(path.join(dir, entry.name));
  }
}

// --- Detection rules -------------------------------------------------------
// Each rule: { kind, test(line, relPath) -> Array<matchedValue> }

const PLACEHOLDER_VALUE = /^(|<.*>|x{3,}|xxx.*|changeme|change_me|replace[_-]?me|your[_-].*|\.\.\.|null|none|todo|tbd|n\/a)$/i;

function stripInlineComment(s) {
  const i = s.indexOf('#');
  return i === -1 ? s : s.slice(0, i);
}

const RULES = [
  {
    kind: 'ZOHO_OAUTH_TOKEN',
    // Two shapes seen in real Zoho OAuth material, both starting with the `1000.` client
    // namespace prefix used across every Zoho DC: a two-dot refresh/grant-token shape
    // (`1000.<20+ chars>.<20+ chars>`) and a single-segment client-id shape
    // (`1000.<25+ chars>`, no second dot) — added for src/books/connection.js's
    // BOOKS_CLIENT_ID / BOOKS_CLIENT_SECRET / stored refresh-token material.
    test: (line) => (line.match(/\b1000\.[0-9a-zA-Z]{10,}\.[0-9a-zA-Z]{10,}\b|\b1000\.[0-9a-zA-Z]{25,}\b(?!\.)/g) ?? []),
  },
  {
    kind: 'GITHUB_TOKEN',
    test: (line) => (line.match(/\b(?:gho|ghp|ghs|ghr)_[0-9A-Za-z]{20,}\b/g) ?? []),
  },
  {
    kind: 'GENERIC_API_KEY',
    test: (line) => (line.match(/\bsk-[0-9A-Za-z]{16,}\b/g) ?? []),
  },
  {
    kind: 'AWS_ACCESS_KEY',
    test: (line) => (line.match(/\bAKIA[0-9A-Z]{16}\b/g) ?? []),
  },
  {
    kind: 'SECRET_CONFIG_VALUE',
    test: (line, relPath) => {
      if (isTemplateConfigFile(relPath)) return [];
      const found = [];
      // Matches two shapes: a quoted JSON key (refresh_token/client_secret/password) followed by
      // a quoted value, or an env-style KEY_NAME=value line where KEY_NAME contains one of those
      // words. Placeholder/empty values (see PLACEHOLDER_VALUE below) are not reported.
      const patterns = [
        /"(refresh_token|client_secret|password)"\s*:\s*"([^"]*)"/gi,
        /\b([A-Z][A-Z0-9_]*(?:REFRESH_TOKEN|CLIENT_SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*(.*)$/g,
      ];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(line))) {
          const value = stripInlineComment(m[2]).trim().replace(/^["']|["']$/g, '');
          if (value && !PLACEHOLDER_VALUE.test(value)) found.push(value);
        }
      }
      return found;
    },
  },
  {
    kind: 'GSTIN',
    test: (line) => (line.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z0-9]\b/g) ?? []),
  },
  {
    kind: 'PAN',
    test: (line) => (line.match(/\b[A-Z]{5}\d{4}[A-Z]\b/g) ?? []),
  },
  {
    kind: 'IN_MOBILE',
    test: (line) => (line.match(/\b[6-9]\d{9}\b/g) ?? []),
  },
  {
    kind: 'EMAIL',
    test: (line) => {
      const all = line.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? [];
      return all.filter((e) => !/\.(local|example|invalid)$/i.test(e));
    },
  },
  {
    kind: 'WINDOWS_PATH',
    test: (line) => (line.match(/[A-Za-z]:[\\/]Users[\\/][^\\/:*?"<>|\r\n]+/g) ?? []),
  },
];

function scanFile(absPath, root) {
  const relPath = path.relative(root, absPath).split(path.sep).join('/');
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  if (text.indexOf(String.fromCharCode(0)) !== -1) return []; // binary, not caught by extension filter
  const findings = [];
  const lines = text.split(/\r\n|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      const matches = rule.test(line, relPath);
      for (const value of matches) {
        if (isAllowlisted(relPath, rule.kind)) continue;
        findings.push({ relPath, lineNo: i + 1, kind: rule.kind, masked: mask(value) });
      }
    }
  }
  return findings;
}

export function checkSecrets(root = ROOT) {
  const files = [];
  walk(root, files);
  const findings = [];
  for (const f of files) findings.push(...scanFile(f, root));
  return findings;
}

function main() {
  const findings = checkSecrets(ROOT);
  if (findings.length === 0) {
    console.log('check-secrets: clean (no matches).');
    return 0;
  }
  console.log(`check-secrets: ${findings.length} finding(s):`);
  for (const f of findings) {
    console.log(`${f.relPath}:${f.lineNo}:${f.kind} (masked: ${f.masked})`);
  }
  return 1;
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  process.exit(main());
}
