# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-04

### Added

- Four tools for the current session: `scratch_write`, `scratch_read`, `scratch_list`, `scratch_clear` — a per-session SQLite scratchpad (`scratch.db`, rows keyed by `session_id`, never part of the global memory / RAG index).
- Clean-exit lifecycle: on the `session.idle` event, a subagent session whose last assistant message has no error gets its scratch rows deleted.
- Crash resume: rows from a crashed or aborted session are kept, so a resumed run of the same session reads its own draft back.
- TTL sweep (7 days) of orphaned rows at plugin startup.
- Limits: `value` ≤ 4 KB with UTF-8-safe truncation; ≤ 200 rows per session (upsert of an existing key is still allowed at the limit).
- `OPENCODE_SCRATCH_DB` environment variable to override the database path (containers, tests, non-default XDG layouts).

### License

MIT — see [LICENSE](./LICENSE).
