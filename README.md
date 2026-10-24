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

Linux, native Windows, and WSL can run the server. On Windows, install the native Windows build of Zellij and run Node, Zellij, and your MCP host in the same Windows environment. In WSL, run all three in the same Linux distribution. A Windows process does not automatically discover sessions inside WSL, or vice versa.

Install from this checkout and register with Codex:

```sh
cd ~/shell-is-all-agents-need
npm install
npm link
codex mcp add shell-is-all-agents-need -- shell-is-all-agents-need --allowed-sessions a,b,c
```

Replace `a,b,c` with your Zellij session names. The first name is the default; use `--session b` to choose another allowed session. `--allowed-sessions` replaces the environment allowlist; the detected current Zellij session is always added, even when it is absent from the explicit list. The first listed session remains the default unless `--session` is specified. Launch Codex, then ask it to open a shared pane and work there. This package is not published to npm yet; `npm link` exposes the local executable.

```sh
codex mcp add shell-is-all-agents-need -- shell-is-all-agents-need --allowed-sessions dev,work --session work
```

After changing the registered arguments, restart the MCP host to apply them. Run `shell-is-all-agents-need --help` for command-line options.

On native Windows, registering Node directly avoids depending on an npm `.cmd` launcher. For example, in PowerShell from this checkout:

```powershell
npm install
codex mcp add shell-is-all-agents-need -- node "$PWD\bin\shell-is-all-agents-need.js"
```

Run the host inside a Zellij pane to detect that session automatically. Windows discovery uses the included Windows PowerShell and a read-only Win32 helper; no separate compiler or administrator privileges are required. Keep optional npm dependencies enabled: Windows background session creation uses `node-pty` (with prebuilt Windows binaries) to supply an isolated ConPTY, without opening a window or attaching the host to the session. Other CLI commands use ordinary pipes. Linux does not load this optional dependency during normal use.

Windows session renaming also starts a small pipe helper to work around Zellij 0.45.1 leaving its IPC endpoints under the original name. The helper restricts access to the current Windows user, survives MCP host restarts, and exits when that Zellij server exits. Subsequent renames reuse the same helper. Terminal processes keep running throughout the rename.

<details>
<summary>Connecting to a session</summary>

Without command-line session options, the server uses environment configuration and attempts automatic discovery. It uses the inherited `ZELLIJ_SESSION_NAME`; on Linux and Windows, it also searches its same-user parent process chain when the MCP host filters that variable. Linux includes PID 1 in a PID namespace; Windows checks process token user SIDs before reading process environments. When a shared Codex daemon breaks that parent chain, discovery also checks same-user Codex CLI processes, excluding `app-server` and `exec-server`. It accepts a session only when all visible client session names agree; clients in multiple sessions remain ambiguous and are not automatically allowed. Only session metadata is returned from process inspection. It does not grant access to every running Zellij session. The detected session is added to the allowed sessions and used as the default unless an environment default is configured. Discovery cannot identify the session if the host has neither the variable nor an accessible ancestor carrying it, for example with inaccessible client environments, clients in multiple sessions, or an isolated process tree. Use `--allowed-sessions` for reliable explicit configuration in those environments.

On other platforms, or when discovery is unavailable (including Windows policies that block PowerShell helpers or process inspection), forward `ZELLIJ_SESSION_NAME` through your MCP host or configure the session explicitly:

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

On Windows, long text is pasted in consecutive chunks to stay within the Windows command-line limit. Unicode code points and input ordering are preserved, and an optional Enter is sent once after the final chunk. Screen captures normalize Windows CRLF line endings.

`list_sessions` returns the configured allowed session names without querying Zellij or filtering by running state. A listed session may be stopped or inaccessible; operations on it still validate that it is running.

For live observation, subscribe to pane IDs, read with the returned subscription ID and cursor, then continue with `next_cursor`. Unsubscribe when finished. Events capture rendered screen updates; history lives in memory, and `gap=true` indicates older events were dropped.

## Development

```sh
npm ci
npm run check
npm run build
```

`check` runs the TypeScript checker and unit tests without requiring Zellij. `build` writes JavaScript, declarations, and source maps to `dist/`; the CLI runs the TypeScript sources directly on Node.js 24+.

To exercise a real Zellij installation, run `npm run test:integration`. This test uses `node-pty` to attach a client in an isolated terminal, creates temporary sessions, and cleans them up afterward. Installing `node-pty` on Linux may require the C++ build tools used by `node-gyp`. The test uses PowerShell on Windows and `sh` on Linux. It skips locally when Zellij is unavailable; missing Zellij fails in CI. Set `SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN` to use a binary outside PATH.

Commit `package-lock.json` to keep installations reproducible. Dependencies, build output, local environment files, credentials, and agent settings are excluded by `.gitignore`. GitHub Actions runs `check`, `build`, and the real Zellij integration test on Linux and Windows for pushes and pull requests. Windows tests also exercise native parent and shared-daemon process discovery.
