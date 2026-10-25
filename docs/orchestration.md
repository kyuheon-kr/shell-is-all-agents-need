# Orchestrate agents in shared panes

An orchestrator can start independent Codex CLI instances, give each a task, observe progress, and send follow-ups using the terminal MCP tools. Subscriptions collect screen changes; they do not wake the orchestrator, deliver instructions, or infer completion.

## Prepare a run

Install and sign into Codex in the same Linux, native Windows, or WSL environment as Zellij. Run `shell-is-all-agents-need --doctor` and inspect `list_tabs` / `list_panes` before starting. Keep existing human panes intact.

Choose a fresh run identifier, for example `review-<UUID>`, and an absolute repository path in that environment. The examples below use `/work/project`; on Windows use a native path such as `C:\\work\\project` in JSON. Record each returned tab and pane ID together with the run identifier, repository, task, and status. IDs below are examples: substitute the actual returned IDs.

## Start three read-only reviewers

Create a separate tab for this run and launch the first worker directly, passing its prompt as one literal argument. This avoids typing a shell command into a program that may have changed.

```json
{
  "tool": "create_tab",
  "arguments": {
    "name": "agent-review-RUN_ID",
    "cwd": "/work/project",
    "command": ["codex", "--cd", "/work/project", "--sandbox", "read-only", "Worker A, run RUN_ID. Inspect runtime code for concrete bugs. Do not modify files or run mutating commands. Report file locations, evidence, and severity. Finish your final response with a line containing only A_DONE_RUN_ID."],
    "focus": false
  }
}
```

Use the returned `tab_id` (shown here as `8`) to create workers B and C. Each worker gets an explicit directory, task, and distinct completion marker.

```json
{
  "tool": "create_pane",
  "arguments": {
    "tab_id": 8,
    "name": "worker-b-tests-RUN_ID",
    "cwd": "/work/project",
    "direction": "right",
    "command": ["codex", "--cd", "/work/project", "--sandbox", "read-only", "Worker B, run RUN_ID. Review test coverage and identify missing failure cases. Do not modify files or run mutating commands. Report concrete gaps with file locations. Finish your final response with a line containing only B_DONE_RUN_ID."]
  }
}
```

Repeat for worker C with `direction: "down"`, the task “review README, setup, and release documentation for inaccuracies,” and marker `C_DONE_RUN_ID`. Direction is a tab-placement hint; it does not select an arbitrary pane to split. Default `focus: false` helps preserve the human's current view.

Inspect the new tab with `list_panes(tab_id=8)` to find worker A's pane; B and C's creation responses return their pane IDs. Capture each worker to check for login, trust, or approval prompts. Resolve those deliberately with the user before sending task input; a started process is not proof that its task has begun.

## Observe and collect

Subscribe to the three returned terminal IDs:

```json
{
  "tool": "subscribe",
  "arguments": { "pane_ids": ["terminal_3", "terminal_4", "terminal_5"], "scrollback_lines": 100 }
}
```

Save `subscription_id` and `cursor`. Call `read_events` with that cursor, `limit: 100`, and `timeout_ms: 10000`. Persist `next_cursor` after every response and read again while `has_more` is true. If `gap` is true, use `capture` to resynchronize the latest screen. An update with `truncated: true` is incomplete; request a concise result or inspect a narrowly scoped screen region/history through `capture`.

The orchestrator must actually read the events and decide what to do next. A subscription does not schedule another model turn. The absence of screen updates means only that the rendered screen has not changed.

Completion markers are evidence only in a worker's finished response for this run. The marker also appears in the submitted prompt and possibly scrollback; finding the string alone is not completion. Inspect the current response/UI and collect each worker's findings, limitations, and validation status. If the result was truncated or is ambiguous, request a concise recap instead of guessing.

## Follow up and cross-review

First inspect `list_panes` and `capture` to confirm the selected pane still belongs to the expected worker and currently accepts prompts. Then send a focused follow-up:

```json
{
  "tool": "send_text",
  "arguments": {
    "pane_id": "terminal_4",
    "text": "For run RUN_ID, cross-review worker A's finding: <paste the finding and evidence>. Check whether tests reproduce it, explain any disagreement, and finish with B_REVIEW_DONE_RUN_ID.",
    "enter": true
  }
}
```

Read the reply explicitly. Human input can interleave; the MCP server serializes its own same-pane input but cannot reserve the keyboard. Never treat a worker's request for approval as a completed task.

## When workers edit code

Use a separate branch and worktree for each writer:

```sh
git fetch origin
git worktree add -b task/worker-a ../project-worker-a origin/main
git worktree add -b task/worker-b ../project-worker-b origin/main
```

Launch each worker with its own worktree as both `cwd` and `--cd`. Assign non-overlapping changes and explicit tests. Have workers commit/push their task branches and open PRs; main protection and required CI still apply. The orchestrator reviews results and coordinates dependent PRs through the normal merge process. Do not have multiple workers switch branches or edit files in one shared checkout.

## Finish or interrupt

Collect the results and unsubscribe with the returned subscription ID. Leave the worker panes available for inspection unless cleanup was requested. To interrupt, capture the specific pane first and use `send_keys` only after checking the current program. To clean up, close only the tab/panes recorded for this run, after rechecking their metadata. Remove worktrees only once their changes are safely committed or intentionally discarded by the user.

On `OPERATION_UNCERTAIN`, inspect the supplied recovery query before creating anything again; observed new IDs may belong to another person. See [runtime controls](runtime.md) for cancellation, output limits, and recovery semantics, and [the official Codex MCP guide](https://developers.openai.com/codex/mcp/) for host registration.
