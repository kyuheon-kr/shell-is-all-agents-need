# shell-is-all-agents-need

**A shell is all agents need.**

**Work with your AI agent in the same live terminal—and jump in anytime.**

Your agent can type commands, read the screen, and work through interactive CLI applications. You can watch it work, edit alongside it, answer a prompt, or hit Ctrl+C yourself. You both have the keyboard.

Inspired by browser-use and [shell-use](https://github.com/kyuheon-kr/shell-use). Powered by Zellij. Connected through MCP.

## A terminal you can work in together

Keep your agent on the left and a shared shell on the right. Ask it to open a Python REPL, investigate a failing command, or work through a debugger. Follow along in the terminal and step in whenever you need to.

```text
You:    Open a shared shell on the right and start a Python REPL.
Agent:  Creates the pane, starts Python, reads the prompt, and types.
You:    Try an expression yourself in that same REPL.
Agent:  Reads the updated screen and continues from there.
```

The human's input is visible to the agent when it reads the screen. New instructions to the agent still go through its host.

## What it can do

- **Read the screen.** See prompts, command output, and interactive applications.
- **Use the keyboard.** Type text, press Enter, navigate, or send Ctrl+C.
- **Follow the work.** Subscribe to screen changes while other interactions continue.
- **Make room.** Create and arrange sessions, tabs, and panes for shared work.

The philosophy is simple: give agents composable terminal tools and let people decide how to collaborate. Work stays visible, human input stays available, and focus stays where the human left it unless explicitly changed.

Zellij provides the shared workspace. shell-is-all-agents-need gives the agent access to it.

## Get started

Requires **Node.js 24+** and **Zellij 0.45.1+** on PATH, running under the same user.

Install from this checkout and register with Codex:

```sh
cd ~/shell-is-all-agents-need
npm install
npm link
codex mcp add shell-is-all-agents-need -- shell-is-all-agents-need --allowed-sessions a,b,c
```

Replace `a,b,c` with your Zellij session names. The first name is the default; use `--session b` to choose another allowed session. Explicit `--allowed-sessions` restricts access to exactly that list, regardless of inherited environment or automatic discovery. Launch Codex, then ask it to open a shared pane and work there. This package is not published to npm yet; `npm link` exposes the local executable.

```sh
codex mcp add shell-is-all-agents-need -- shell-is-all-agents-need --allowed-sessions dev,work --session work
```

After changing the registered arguments, restart the MCP host to apply them. Run `shell-is-all-agents-need --help` for command-line options.

<details>
<summary>Connecting to a session</summary>

Without command-line session options, the server uses environment configuration and attempts automatic discovery. It uses the inherited `ZELLIJ_SESSION_NAME`; on Linux, it also searches its same-user parent process chain (including PID 1 in a PID namespace) when the MCP host filters that variable. The detected session is added to the allowed sessions and used as the default unless an environment default is configured. Discovery cannot identify the session if the host has neither the variable nor an accessible ancestor carrying it, for example with a detached daemon or isolated process tree. Use `--allowed-sessions` for reliable explicit configuration in those environments.

On other platforms, or when discovery is unavailable, forward `ZELLIJ_SESSION_NAME` through your MCP host or configure the session explicitly:

```sh
codex mcp add shell-is-all-agents-need \
  --env SHELL_IS_ALL_AGENTS_NEED_SESSION=dev \
  --env SHELL_IS_ALL_AGENTS_NEED_SESSIONS=dev,work \
  -- shell-is-all-agents-need
```

`SHELL_IS_ALL_AGENTS_NEED_SESSION` sets the default; `SHELL_IS_ALL_AGENTS_NEED_SESSIONS` allows additional names, including sessions to create. The detected current session is automatically allowed.

</details>

## The tools

| Interaction | Tools |
| --- | --- |
| See and type | `capture`, `send_text`, `send_keys` |
| Follow changes | `subscribe`, `read_events`, `unsubscribe` |
| Manage sessions | `list_sessions`, `create_session`, `rename_session`, `close_session` |
| Manage tabs | `list_tabs`, `create_tab`, `rename_tab`, `close_tab`, `focus_tab` |
| Manage panes | `list_panes`, `create_pane`, `rename_pane`, `close_pane`, `focus_pane`, `resize_pane` |

Discover tab and pane IDs through the list tools. Targeted calls use the default session unless `session` is supplied. `send_text` pastes without Enter by default; use `enter=true` to submit. Input goes to the program running in the pane.

`list_sessions` returns the configured allowed session names without querying Zellij or filtering by running state. A listed session may be stopped or inaccessible; operations on it still validate that it is running.

For live observation, subscribe to pane IDs, read with the returned subscription ID and cursor, then continue with `next_cursor`. Unsubscribe when finished. Events capture rendered screen updates; history lives in memory, and `gap=true` indicates older events were dropped.

## Development

```sh
npm ci
npm run check
npm run build
```

`check` runs the TypeScript checker and unit tests without requiring Zellij. `build` writes JavaScript, declarations, and source maps to `dist/`; the CLI runs the TypeScript sources directly on Node.js 24+.

To exercise a real Zellij installation, run `npm run test:integration`. This test creates temporary sessions and cleans them up afterward. It skips when Zellij is unavailable. Set `SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN` to use a binary outside PATH.

Commit `package-lock.json` to keep installations reproducible. Dependencies, build output, local environment files, credentials, and agent settings are excluded by `.gitignore`. GitHub Actions runs `check` and `build` on pushes and pull requests.
