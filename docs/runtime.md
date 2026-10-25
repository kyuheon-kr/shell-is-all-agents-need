# Runtime controls

Pane programs have no execution deadline: keep servers, REPLs, and agents running and use `capture` or subscriptions to observe them. These are snapshots of rendered terminal state, not command-completion signals.

Zellij control requests have a default 10-second deadline. Set `SHELL_IS_ALL_AGENTS_NEED_TIMEOUT_MS` in the MCP server environment to another nonnegative integer in milliseconds, or `0` to disable that deadline. MCP hosts can have their own request deadlines. Cancellation remains available even with the CLI deadline disabled.

A timeout or cancellation releases the request's pipes and terminates its CLI process, without killing unrelated background servers or pane programs. Errors include bounded `partial_stdout` and `partial_stderr` diagnostics when available; partial output is not returned as a successful screen capture. Read operations can be requested again. A modifying operation may already have happened, so inspect the session/panes before retrying it.

MCP results are limited to 2MiB including both text and structured JSON. `capture.truncated` reports omitted lines or bytes and preserves the latest text. Oversized subscription updates preserve the tail of the viewport/scrollback and include `truncated` and `original_bytes`. `read_events` pages by bytes and event count; follow `next_cursor` while `has_more` is true. `gap` separately reports events evicted from the collector's buffer. Narrow large metadata queries when they return `RESOURCE_LIMIT`.
