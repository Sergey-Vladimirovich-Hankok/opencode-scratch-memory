// Тесты scratch-plugin (эфемерная сессионная БД, отчёт session_scoped_memory_analysis §5-§8).
// Работают на ВРЕМЕННОМ файле БД, реальный ~/.local/omni/memory/scratch.db не трогают.
// Раннер: bun test tests/test_scratch_plugin.js
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  openScratchDB, sweepTTL, scratchWrite, scratchRead, scratchList, scratchClear,
  decideIdleCleanup, handleSessionIdle, buildTools, truncateUtf8,
  TTL_MS, MAX_VALUE_BYTES, MAX_ROWS_PER_SESSION,
} from '../src/scratch-plugin.js';

let dir, file, d;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scratch-test-'));
  file = join(dir, 'scratch.db');
  d = openScratchDB(file);
});

afterEach(() => {
  d.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scratch — upsert', () => {
  test('два upsert одного (session, kind, key) → одна строка, value обновлён', () => {
    expect(scratchWrite(d, 'sessA', 'fact', 'limit', 'v1').ok).toBe(true);
    const ts1 = d.query('SELECT ts FROM scratch WHERE session_id = ? AND key = ?').get('sessA', 'limit').ts;
    expect(scratchWrite(d, 'sessA', 'fact', 'limit', 'v2').ok).toBe(true);
    const rows = d.query('SELECT * FROM scratch WHERE session_id = ?').all('sessA');
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe('v2');
    expect(rows[0].ts).toBeGreaterThanOrEqual(ts1); // upsert обновил ts, строка одна
  });
});

describe('scratch — изоляция сессий', () => {
  test('запись в A не видна из B', () => {
    scratchWrite(d, 'sessA', 'fact', 'k', 'only-A');
    expect(scratchRead(d, 'sessB', {})).toHaveLength(0);
    expect(scratchList(d, 'sessB')).toHaveLength(0);
  });

  test('чужой sessionID в args игнорируется — пишется в сессию из контекста', async () => {
    const tools = buildTools(() => d);
    const out = await tools.scratch_write.execute(
      { kind: 'fact', key: 'k', value: 'x', sessionID: 'EVIL_SESSION' },
      { sessionID: 'sessA' },
    );
    expect(JSON.parse(out).ok).toBe(true);
    expect(scratchRead(d, 'EVIL_SESSION', {})).toHaveLength(0);
    expect(scratchRead(d, 'sessA', {})).toHaveLength(1);
  });
});

describe('scratch — фильтры scratch_read', () => {
  beforeEach(() => {
    scratchWrite(d, 's', 'fact', 'f1', 'fact-val');
    scratchWrite(d, 's', 'path', 'p1', 'path-val');
    scratchWrite(d, 's', 'path', 'p2', 'path-val-2');
  });

  test('фильтр по kind', () => {
    const rows = scratchRead(d, 's', { kind: 'path' });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.kind === 'path')).toBe(true);
  });

  test('фильтр по key', () => {
    const rows = scratchRead(d, 's', { key: 'p2' });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('path-val-2');
  });

  test('без фильтров — всё', () => {
    expect(scratchRead(d, 's', {})).toHaveLength(3);
  });
});

describe('scratch — scratch_clear', () => {
  test('удаляет только свою сессию', () => {
    scratchWrite(d, 'sessA', 'fact', 'k', 'a');
    scratchWrite(d, 'sessB', 'fact', 'k', 'b');
    const res = scratchClear(d, 'sessA');
    expect(res.deleted).toBe(1);
    expect(scratchRead(d, 'sessA', {})).toHaveLength(0);
    expect(scratchRead(d, 'sessB', {})).toHaveLength(1);
  });
});

describe('scratch — дискриминатор чистый/аварийный выход', () => {
  beforeEach(() => {
    scratchWrite(d, 'sub', 'progress', 'step1', 'done');
  });

  test('error == null → DELETE строк', () => {
    const messages = [
      { info: { role: 'user' }, parts: [] },
      { info: { role: 'assistant', error: null }, parts: [] },
    ];
    expect(decideIdleCleanup(messages)).toBe('clear');
    const res = handleSessionIdle(d, 'sub', messages);
    expect(res.action).toBe('clear');
    expect(res.deleted).toBe(1);
    expect(scratchRead(d, 'sub', {})).toHaveLength(0);
  });

  test('error != null → строки сохранены (resume прочитает)', () => {
    const messages = [
      { info: { role: 'assistant', error: { name: 'Error', data: { message: 'aborted' } } }, parts: [] },
    ];
    expect(decideIdleCleanup(messages)).toBe('keep');
    const res = handleSessionIdle(d, 'sub', messages);
    expect(res.action).toBe('keep');
    expect(res.deleted).toBe(0);
    expect(scratchRead(d, 'sub', {})).toHaveLength(1);
  });

  test('нет assistant-сообщения → skip (консервативно)', () => {
    expect(decideIdleCleanup([{ info: { role: 'user' }, parts: [] }])).toBe('skip');
    expect(handleSessionIdle(d, 'sub', [{ info: { role: 'user' } }]).deleted).toBe(0);
    expect(scratchRead(d, 'sub', {})).toHaveLength(1);
  });

  test('после assistant идёт tool/user → skip (idle между шагами, не стираем)', () => {
    const messages = [
      { info: { role: 'assistant', error: null }, parts: [] },
      { info: { role: 'tool' }, parts: [] },
    ];
    expect(decideIdleCleanup(messages)).toBe('skip');
    expect(handleSessionIdle(d, 'sub', messages).deleted).toBe(0);
    expect(scratchRead(d, 'sub', {})).toHaveLength(1);
  });
});

describe('scratch — TTL-подметание', () => {
  test('строка 8 дней назад удалена, 1 день — осталась', () => {
    const now = Date.now();
    d.query('INSERT INTO scratch (session_id, kind, key, value, ts) VALUES (?,?,?,?,?)').run('old', 'fact', 'k8', 'v', now - 8 * 24 * 60 * 60 * 1000);
    d.query('INSERT INTO scratch (session_id, kind, key, value, ts) VALUES (?,?,?,?,?)').run('new', 'fact', 'k1', 'v', now - 1 * 24 * 60 * 60 * 1000);
    const removed = sweepTTL(d, now);
    expect(removed).toBe(1);
    expect(d.query('SELECT COUNT(*) AS c FROM scratch WHERE session_id = ?').get('old').c).toBe(0);
    expect(d.query('SELECT COUNT(*) AS c FROM scratch WHERE session_id = ?').get('new').c).toBe(1);
  });
});

describe('scratch — лимиты §5', () => {
  test('value > 4KB обрезается с маркером', () => {
    const big = 'x'.repeat(MAX_VALUE_BYTES + 5000);
    const res = scratchWrite(d, 's', 'fact', 'big', big);
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    const row = d.query('SELECT value FROM scratch WHERE key = ?').get('big');
    expect(Buffer.byteLength(row.value, 'utf8')).toBeLessThanOrEqual(MAX_VALUE_BYTES + 20); // маркер
    expect(row.value.endsWith('…[truncated]')).toBe(true);
  });

  test('UTF-8-символы не разрываются при обрезке', () => {
    const { text, truncated } = truncateUtf8('абв'.repeat(2000), 100);
    expect(truncated).toBe(true);
    expect(() => Buffer.from(text, 'utf8').toString('utf8')).not.toThrow();
    expect(text.endsWith('…[truncated]')).toBe(true);
  });

  test('лимит 200 строк на сессию: новая строка отклоняется, upsert — разрешён', () => {
    for (let i = 0; i < MAX_ROWS_PER_SESSION; i++) scratchWrite(d, 's', 'fact', `k${i}`, 'v');
    expect(scratchWrite(d, 's', 'fact', 'k-new', 'v').ok).toBe(false);
    expect(scratchWrite(d, 's', 'fact', 'k-new', 'v').warning).toBeTruthy();
    // upsert существующего ключа — всё ещё работает
    expect(scratchWrite(d, 's', 'fact', 'k0', 'updated').ok).toBe(true);
    expect(d.query('SELECT COUNT(*) AS c FROM scratch WHERE session_id = ?').get('s').c).toBe(MAX_ROWS_PER_SESSION);
  });
});

describe('scratch — схема §5', () => {
  test('таблица scratch: PK (session_id, kind, key), индекс idx_scratch_session', () => {
    const table = d.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='scratch'").get();
    expect(table.sql).toContain('PRIMARY KEY (session_id, kind, key)');
    const idx = d.query("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_scratch_session'").get();
    expect(idx.sql).toContain('scratch(session_id, ts)');
  });

  test('WAL режим включён', () => {
    expect(d.query('PRAGMA journal_mode').get().journal_mode).toBe('wal');
  });
});
