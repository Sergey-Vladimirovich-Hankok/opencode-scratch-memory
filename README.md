# OpenCode Scratch Memory

Session-scoped scratch memory for OpenCode subagents.

A subagent gets a tiny private notepad (`fact`, `path`, `command`, `progress`,
`baseline`, `decision`) that lives in its own `~/.local/omni/memory/scratch.db`.
The rows are scoped by `session_id`, so nothing leaks between subagents and
nothing reaches the global memory RAG index.

Lifecycle:

- Written through the `scratch_write` / `scratch_read` / `scratch_list` /
  `scratch_clear` tools, which are always scoped to the calling session — a
  `session_id` passed in the arguments is ignored.
- On a clean exit (`session.idle` where the last message is an assistant
  message with `error == null`) the session's rows are deleted.
- On a crash or error the rows are kept, so `resume` on the same session picks
  the draft back up.
- Orphaned rows from sessions that never got an `idle` event are swept by TTL
  (7 days) on plugin startup.

Limits: `value` ≤ 4 KB, ≤ 200 rows per session.

## Install

npm:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-scratch-memory"]
}
```

Or from a local checkout — copy `src/scratch-plugin.js` into
`~/.config/opencode/plugins/`, or point at it directly:

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
| `OPENCODE_SCRATCH_DB` | `~/.local/omni/memory/scratch.db` | Database path |

## Test

```sh
bun test
```