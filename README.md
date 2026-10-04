# OpenCode Scratch Memory

Session-scoped scratch memory for OpenCode subagents.

## Why

Subagents work in bursts: a few tool calls, then the next step. Long tasks hit
context compaction, and anything the subagent "remembered" (a file path it
found, a command it ran, a baseline it measured) is gone — the resumed or next
step starts from scratch and re-discovers the same facts.

`opencode-scratch-memory` gives every subagent session a tiny private notepad:
a per-session SQLite scratchpad that survives within the session, is wiped on a
clean exit, and deliberately **never** enters the global memory / RAG index.

## How it works

- One SQLite file (`scratch.db`), rows keyed by `session_id`. Rows are scoped
  to the calling session only — a `session_id` passed in tool arguments is
  ignored, and other sessions' rows are invisible.
- The plugin listens to `session.idle` events. When a **subagent** session
  (`parentID != null`) ends with its last assistant message having
  `error == null`, its scratch rows are deleted (clean exit).
- If the session ended with an error (crash, abort), the rows are **kept**, so
  a resumed run of the same session can read its own draft back.
- Orphaned rows (session never produced an `idle` event) are swept by TTL
  (7 days) on plugin startup.

## Tools

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `scratch_write` | `kind` (enum), `key` (string), `value` (string, ≤ 4 KB) | Upsert a fact into the current session's notepad. |
| `scratch_read` | `kind?`, `key?` | Read the current session's facts; optional filters (no args = everything). |
| `scratch_list` | — | Outline of the notepad: `kind` + `key` + `ts` per row (no values). |
| `scratch_clear` | — | Manually wipe the current session's notepad. |

Valid `kind` values: `fact`, `path`, `command`, `progress`, `baseline`,
`decision`.

Limits: `value` ≤ 4 KB (UTF-8-safe truncation with a `…[truncated]` marker),
≤ 200 rows per session (upsert of an existing key is still allowed at the
limit).

## Install

**Option 1 — npm** (add to your `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-scratch-memory"]
}
```

**Option 2 — copy the file** into the plugins directory:

```sh
cp src/scratch-plugin.js ~/.config/opencode/plugins/
```

**Option 3 — absolute path** to the file in the `plugin` array:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-scratch-memory/src/scratch-plugin.js"]
}
```

Restart OpenCode after changing the config (plugins load at startup).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENCODE_SCRATCH_DB` | `~/.local/omni/memory/scratch.db` | Path to the SQLite scratch database. Override it for containers, tests, or a non-default XDG layout. |

## Example session

A subagent refactoring a module, across two steps with compaction in between:

```
step 1:
  scratch_write(kind="path",     key="main_module", value="src/parser/ast.js")
  scratch_write(kind="baseline", key="tests",       value="142 pass / 0 fail before change")
  scratch_write(kind="decision", key="approach",    value="rewrite lexer first, keep public API")

... context compaction happens ...

step 2 (resumed, context is fresh):
  scratch_list()          → path/main_module, baseline/tests, decision/approach
  scratch_read(key="baseline") → 142 pass / 0 fail before change
  ... does the work ...
  scratch_write(kind="progress", key="done", value="lexer rewritten, 142 pass / 0 fail")

session ends cleanly → rows deleted automatically.
```

If step 2 had crashed instead, the rows would survive, and a resumed run of
the same session would see the same `scratch_list()`.

## Testing

```sh
bun test
```

17 tests cover upsert semantics, session isolation, read filters, the
clean-exit / crash / skip discriminator, TTL sweep, the 4 KB and 200-row
limits, UTF-8-safe truncation, and the schema (WAL, primary key, index).

## License

MIT — see [LICENSE](./LICENSE).
