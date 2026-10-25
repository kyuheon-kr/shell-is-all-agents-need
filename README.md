# shell-is-all-agents-need

**A shell is all agents need.**

An MCP server for sharing a live Zellij terminal with your AI agent. Read screens, type commands, run interactive programs, and manage sessions, tabs, and panes. You can step in and use the same keyboard anytime.

Inspired by browser-use and [shell-use](https://github.com/kyuheon-kr/shell-use).

## Use cases

- **Work together:** share a shell, REPL, debugger, or interactive CLI with your agent and step in anytime.
- **Orchestrate agents:** have one agent launch Codex instances in separate panes, assign parallel tasks, collect results, send follow-ups, and coordinate reviews—all through the same terminal tools.

Try: “Start three Codex agents in separate panes: one to inspect the code, one to review tests, and one to check the docs. Collect their findings and have them cross-review.”

Give each worker an explicit working directory and completion marker. Use separate worktrees when workers edit files. The orchestrator must read pane updates and send follow-ups; subscriptions do not automatically wake agents or deliver instructions.

## Quick start

Requires **Node.js 24+** and **Zellij 0.45.1+** on PATH, running as the same user. Use the same environment for Node, Zellij, and your MCP host: Linux, native Windows, or one WSL distribution.

In bash/zsh or PowerShell:

```sh
npm install -g shell-is-all-agents-need
codex mcp add shell-is-all-agents-need -- shell-is-all-agents-need
```

Restart your MCP host and launch it inside a Zellij pane. Then ask: “Open a shared shell on the right and start a Python REPL.”

The current session is detected automatically, including through a shared Codex daemon when its clients agree on one session. If detection is unavailable or ambiguous, append `--allowed-sessions dev,work --session work` to the registration command. The first listed session is the default unless `--session` is supplied; the detected current session is always allowed.

More options: `shell-is-all-agents-need --help`.

<details>
<summary>Platform notes</summary>

- **Windows:** keep optional npm dependencies enabled. Background session creation uses `node-pty`; discovery and session renaming use Windows PowerShell helpers. The rename helper is restricted to your Windows user, survives MCP host restarts, and exits with the Zellij session.
- **WSL:** Windows and WSL sessions are separate; run all components in the same distribution.
- **Linux development:** the integration test's `node-pty` dependency may need C++ build tools for `node-gyp`.

</details>

## Tools

| Purpose | Tools |
| --- | --- |
| Screen & keyboard | `capture`, `send_text`, `send_keys` |
| Live updates | `subscribe`, `read_events`, `unsubscribe` |
| Sessions | `list_sessions`, `create_session`, `rename_session`, `close_session` |
| Tabs | `list_tabs`, `create_tab`, `rename_tab`, `close_tab`, `focus_tab` |
| Panes | `list_panes`, `create_pane`, `rename_pane`, `close_pane`, `focus_pane`, `resize_pane` |

Use IDs returned by the list tools. `send_text` pastes without Enter; set `enter=true` to submit. `list_sessions` returns allowed names, including stopped sessions. For live updates, read with the returned cursor and unsubscribe when finished.

Observations show rendered screen state. New instructions to the agent still go through its host.

## Development

```sh
npm ci
npm run build             # Compile the CLI to dist/ before running locally
npm run check             # TypeScript + unit tests
npm run test:integration  # Real Zellij sessions, I/O, and lifecycle
npm run test:package      # Install the tarball and check the CLI + MCP
```

For a local MCP registration, use `node "$PWD/bin/shell-is-all-agents-need.js"`. Integration tests create temporary sessions and clean them up afterward; they skip locally if Zellij is missing. Set `SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN` for a binary outside PATH. CI runs all checks on Linux and Windows.

Develop on branches and open a PR; Linux and Windows CI must pass before merging into `main`. Version PRs and optional npm/GitHub releases follow [the release guide](docs/releasing.md).
