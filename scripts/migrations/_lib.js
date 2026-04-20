/**
 * Shared helpers for CLI migration scripts.
 *   - parseCsv(filePath) → array of objects (header row auto-detected)
 *   - args() → {flags, positional}
 *   - getClient() → pg Client connected via DATABASE_URL (or PG* vars)
 *   - progress(current, total, label)
 */
const fs = require('fs');
const { Client } = require('pg');

function parseCsv(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, j) => {
      const v = (cells[j] ?? '').trim();
      obj[h] = v === '' ? null : v;
    });
    rows.push(obj);
  }
  return { headers, rows };
}

// minimal RFC-4180-ish splitter: handles quoted fields and embedded commas
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inside = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inside) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inside = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') {
        out.push(cur);
        cur = '';
      } else if (ch === '"') {
        inside = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

function args() {
  const a = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (const token of a) {
    if (token.startsWith('--')) {
      const [key, val] = token.slice(2).split('=');
      flags[key] = val == null ? true : val;
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

async function getClient() {
  const client = new Client(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : undefined,
  );
  await client.connect();
  return client;
}

function progress(current, total, label = 'progress') {
  const pct = total > 0 ? Math.floor((current / total) * 100) : 0;
  process.stdout.write(`\r${label}: ${current}/${total} (${pct}%)   `);
  if (current >= total) process.stdout.write('\n');
}

function parseBool(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'نعم'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'لا'].includes(s)) return false;
  return null;
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function normalizePhoneEG(v) {
  if (!v) return null;
  let p = String(v).replace(/[^0-9+]/g, '');
  // +201... or 0020... → 01...
  if (p.startsWith('+20')) p = '0' + p.slice(3);
  else if (p.startsWith('0020')) p = '0' + p.slice(4);
  else if (p.startsWith('20') && p.length === 12) p = '0' + p.slice(2);
  return p;
}

module.exports = {
  parseCsv,
  args,
  getClient,
  progress,
  parseBool,
  parseNum,
  parseDate,
  normalizePhoneEG,
};
