// Ephemeral session-scoped "scratchpad" DB for subagents (variant C from the
// docs/session_scoped_memory_analysis_2026-10-04.md report, §5-§8).
// One SQLite scratch.db, rows keyed by session_id; NOT in memory.db → never
// enters the global RAG index.
// Lifecycle: written by the scratch_* tools → on a clean subagent exit
// (session.idle + last assistant message with error==null) the rows are
// deleted → on crash/error they are kept (a resume will read them back) →
// orphaned rows are swept by TTL at plugin startup.
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { tool } from '@opencode-ai/plugin';

// DB path. Overridable via env var (e.g. a different XDG layout, containers,
// tests). Default — next to the global opencode memory.
export const DB_PATH =
  process.env.OPENCODE_SCRATCH_DB || join(homedir(), '.local/omni/memory/scratch.db');
export const TTL_MS = 7 * 24 * 60 * 60 * 1000;      // §5: TTL ≈ 7 days
export const MAX_VALUE_BYTES = 4096;                // §5: value ≤ ~4 KB
export const MAX_ROWS_PER_SESSION = 200;            // §5: ≤ ~200 rows per session
const KINDS = ['fact', 'path', 'command', 'progress', 'baseline', 'decision']; // §5

let db = null;

// Opens scratch.db at the given path (WAL + schema §5). Exported for tests on a tmp file.
export function openScratchDB(path) {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const d = new Database(path, { create: true });
  d.run('PRAGMA journal_mode = WAL');
  d.exec(`
    CREATE TABLE IF NOT EXISTS scratch (
      session_id TEXT NOT NULL,
      kind       TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT,
      ts         INTEGER NOT NULL,
      PRIMARY KEY (session_id, kind, key)
    );
    CREATE INDEX IF NOT EXISTS idx_scratch_session ON scratch(session_id, ts);
  `);
  return d;
}

// TTL sweep of orphaned rows (risk §7g). Returns the number of rows removed.
export function sweepTTL(d, nowMs = Date.now()) {
  const r = d.query('DELETE FROM scratch WHERE ts < ?').run(nowMs - TTL_MS);
  return Number(r?.changes ?? 0);
}

function getDB() {
  if (db) return db;
  try {
    db = openScratchDB(DB_PATH);
    const removed = sweepTTL(db);
    if (removed > 0) console.error(`[scratch] TTL sweep: removed ${removed} stale row(s)`);
  } catch (e) {
    console.error('[scratch] DB init error:', e);
    db = null;
  }
  return db;
}

// Byte truncation without splitting a UTF-8 character (limit §5: ≤4 KB, truncated with a warning marker).
export function truncateUtf8(value, maxBytes) {
  const b = Buffer.from(value, 'utf8');
  if (b.length <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (b[end - 1] & 0xc0) === 0x80) end--;
  return { text: b.slice(0, end).toString('utf8') + '…[truncated]', truncated: true };
}

// Upsert a fact into a session (PK = session_id+kind+key). Limits §5: value ≤4KB, ≤200 new rows.
export function scratchWrite(d, sessionID, kind, key, value) {
  if (!KINDS.includes(kind)) return { ok: false, error: `unknown kind: ${kind} (expected: ${KINDS.join('|')})` };
  if (typeof key !== 'string' || !key) return { ok: false, error: 'key is required' };
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const { text, truncated } = truncateUtf8(raw, MAX_VALUE_BYTES);
  const isNew = !d.query('SELECT 1 AS x FROM scratch WHERE session_id = ? AND kind = ? AND key = ?')
    .get(sessionID, kind, key);
  if (isNew) {
    const cnt = d.query('SELECT COUNT(*) AS c FROM scratch WHERE session_id = ?').get(sessionID).c;
    if (cnt >= MAX_ROWS_PER_SESSION) {
      return { ok: false, warning: `limit ${MAX_ROWS_PER_SESSION} rows/session reached — new row rejected (upsert of existing key still allowed)` };
    }
  }
  d.query(`
    INSERT INTO scratch (session_id, kind, key, value, ts) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, kind, key) DO UPDATE SET value = excluded.value, ts = excluded.ts
  `).run(sessionID, kind, key, text, Date.now());
  return { ok: true, truncated };
}

// Read facts of the CURRENT session (sessionID only from context, not from args). Filters: kind?, key?.
export function scratchRead(d, sessionID, { kind, key } = {}) {
  let sql = 'SELECT kind, key, value, ts FROM scratch WHERE session_id = ?';
  const params = [sessionID];
  if (kind) { sql += ' AND kind = ?'; params.push(kind); }
  if (key) { sql += ' AND key = ?'; params.push(key); }
  sql += ' ORDER BY ts ASC';
  return d.query(sql).all(...params);
}

// Outline (kind+key+ts) of the current session.
export function scratchList(d, sessionID) {
  return d.query('SELECT kind, key, ts FROM scratch WHERE session_id = ? ORDER BY ts ASC').all(sessionID);
}

// Manual wipe of the current session.
export function scratchClear(d, sessionID) {
  const r = d.query('DELETE FROM scratch WHERE session_id = ?').run(sessionID);
  return { ok: true, deleted: Number(r?.changes ?? 0) };
}

// "Clean vs crash" discriminator (§7a): the last assistant message.
// error==null → 'clear' (clean exit); error!=null → 'keep' (crash — a resume will read it).
// No assistant message → 'skip' (conservative, TTL will pick it up).
// Assistant is NOT the last message of the session (a tool/user message follows it —
// i.e. the run may have been interrupted, or idle arrived between steps) → 'skip':
// wiping the scratchpad early is not allowed.
export function decideIdleCleanup(messages) {
  if (!Array.isArray(messages)) return 'skip';
  const last = messages[messages.length - 1];
  if (last?.info?.role !== 'assistant') return 'skip';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.info?.role === 'assistant') {
      return m.info?.error == null ? 'clear' : 'keep';
    }
  }
  return 'skip';
}

// Action on idle: 'clear' → DELETE the session's rows; otherwise leave them alone.
export function handleSessionIdle(d, sessionID, messages) {
  const action = decideIdleCleanup(messages);
  if (action !== 'clear') return { action, deleted: 0 };
  const r = d.query('DELETE FROM scratch WHERE session_id = ?').run(sessionID);
  return { action, deleted: Number(r?.changes ?? 0) };
}

// The 4 tools from §6. Scope — ONLY ToolContext.sessionID (tool.d.ts:3); sessionID from args is ignored.
export function buildTools(getDB) {
  const guard = (fn) => async (args, ctx) => {
    try {
      const d = getDB();
      if (!d) return JSON.stringify({ ok: false, error: 'scratch db unavailable' });
      const sid = ctx?.sessionID;
      if (!sid) return JSON.stringify({ ok: false, error: 'no sessionID in context' });
      return JSON.stringify(fn(d, sid, args || {}));
    } catch (e) {
      console.error('[scratch] tool error:', e);
      return JSON.stringify({ ok: false, error: String(e?.message || e) });
    }
  };
  return {
    "scratch_write": tool({
      description: "Save a fact of the current session to the ephemeral scratchpad (survives a crash, wiped on a clean exit). Write here: project facts/constraints, file paths, commands + exit code, baseline (tests BEFORE the change), progress (done/remaining), decision (what + why). Do NOT write: full dialogue, secrets/tokens, full tool outputs (summary + exit code only).",
      args: {
        kind: tool.schema.enum(KINDS).describe("fact | path | command | progress | baseline | decision"),
        key: tool.schema.string().describe("sub-key: file, command name, item"),
        value: tool.schema.string().describe("text or JSON, ≤4 KB (excess is truncated)"),
      },
      execute: guard((d, sid, args) => scratchWrite(d, sid, args.kind, args.key, args.value)),
    }),
    "scratch_read": tool({
      description: "Read facts from the current session's scratchpad. Filters: kind? and key? (no args — everything).",
      args: {
        kind: tool.schema.enum(KINDS).optional().describe("filter by kind"),
        key: tool.schema.string().optional().describe("filter by key (exact match)"),
      },
      execute: guard((d, sid, args) => ({ ok: true, rows: scratchRead(d, sid, { kind: args.kind, key: args.key }) })),
    }),
    "scratch_list": tool({
      description: "Outline of the current scratchpad: kind+key+ts of each row (no values).",
      args: {},
      execute: guard((d, sid) => ({ ok: true, rows: scratchList(d, sid) })),
    }),
    "scratch_clear": tool({
      description: "Manually wipe the current session's scratchpad (current session only).",
      args: {},
      execute: guard((d, sid) => scratchClear(d, sid)),
    }),
  };
}

export const ScratchPlugin = async ({ client }) => {
  getDB(); // init + TTL sweep at startup

  return {
    event: async ({ event }) => {
      try {
        if (event?.type !== 'session.idle') return;
        const sid = event?.properties?.sessionID;
        if (!sid) return; // §7d: sessionID may be missing
        const d = getDB();
        if (!d) return;
        // Subagent sessions only (parentID != null, §2)
        let parentID = null;
        try {
          const info = await client.session.get({ path: { id: sid } });
          parentID = info?.data?.parentID ?? null;
        } catch (_) {
          return; // session not found / error — leave it alone
        }
        if (!parentID) return;
        const resp = await client.session.messages({ path: { id: sid } });
        const data = resp?.data ?? resp;
        const messages = Array.isArray(data) ? data : (data?.messages ?? []);
        const { action } = handleSessionIdle(d, sid, messages);
        if (action === 'clear') console.error(`[scratch] clean exit: cleared session ${sid}`);
      } catch (e) {
        console.error('[scratch] idle handler error:', e);
      }
    },
    tool: buildTools(getDB),
  };
};
