# Working agreements

- Develop on a task branch and finish requested changes by committing, pushing that branch, and opening a pull request against `main`. Never push changes directly to `main`. Do not ask for routine confirmation; follow explicit requests to hold a push or leave changes uncommitted.
- Merge only when requested, through a pull request with required CI passing. Never bypass branch protection. Releases and npm publishing are separate, explicitly requested operations; follow `docs/releasing.md`.
- Stage only files belonging to the task. Preserve unrelated user changes; never discard them or force-push without explicit authorization.
- Report the resulting branch, commit hash, push status, and relevant validation results when finishing.
- Keep the README compact. Prioritize quick setup, major use cases, and essential commands; avoid duplicating tool descriptions or lengthy implementation details.
- Prefer the `shell-is-all-agents-need` MCP tools for shared-terminal work and terminal-based agent orchestration. Inspect the current program before sending input, use explicit pane IDs, and leave unrelated panes alone.
- When launching worker agents, specify the repository working directory explicitly, assign clear tasks and completion markers, and use separate worktrees for concurrent edits. Read results and send follow-ups explicitly; subscriptions do not automatically instruct or wake agents.
- For code changes, run `npm run check` and `npm run build`. Run `npm run test:integration` when changing Zellij commands, process handling, or subscriptions. For documentation-only changes, review the diff and run `git diff --check`.
- Diagnose CLI failures using bounded output and command context. Retry only understood transient failures in safe read operations; never blindly replay mutations or suppress malformed output.
