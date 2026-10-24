import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ZellijError } from './errors.ts';
import type { ZellijClient } from './zellij.ts';
import type { SubscriptionManager } from './subscriptions.ts';

export function registerTools(server: McpServer, client: ZellijClient, subscriptions: SubscriptionManager): void {
  const session = z.string().min(1).optional().describe('Allowed session name; defaults to the session fixed at server startup.');
  const pane_id = z.string().regex(/^(terminal|plugin)_\d+$/u).describe('Typed, session-local pane ID returned by list_panes.');
  const tab_id = z.number().int().nonnegative().describe('Stable tab ID, not the tab position.');
  const name = z.string().min(1);
  const creation = {
    name: name.optional(), cwd: z.string().min(1).optional(),
    command: z.array(z.string()).min(1).optional().describe('Executable and literal arguments. Omit to open the default shell.'),
    focus: z.boolean().default(false).describe('Explicitly give the created tab/pane focus.'),
  };
  function add<S extends z.ZodRawShape>(
    toolName: string, description: string, shape: S,
    handler: (args: z.output<z.ZodObject<S>>, signal: AbortSignal) => unknown | Promise<unknown>,
    readOnly = false, destructive = false,
  ): void {
    const schema = z.object(shape).strict();
    server.registerTool(toolName, {
      description, inputSchema: schema,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false },
    }, async (args, ctx) => {
      try {
        const output = await handler(schema.parse(args), ctx.mcpReq.signal);
        const structuredContent = output as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent };
      } catch (error) {
        const output = { error: {
          code: error instanceof ZellijError ? error.code : error instanceof z.ZodError ? 'INVALID_ARGUMENT' : 'CLI_ERROR',
          message: error instanceof Error ? error.message : String(error),
        } };
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
      }
    });
  }

  add('list_sessions', 'List all configured allowed sessions, regardless of whether they are running. Does not query Zellij.', {},
    (_, signal) => client.listSessions(signal), true);
  add('create_session', 'Create an allowed session in the background. Existing sessions return ALREADY_EXISTS.', { name },
    (a, signal) => client.createSession(a.name, signal));
  add('rename_session', 'Rename a session to another configured allowed name. Updates the default if it targets this session.', { session, name },
    async (a, signal) => {
      const previous = client.scope.resolve(a.session);
      const result = await client.renameSession(a.name, previous, signal);
      subscriptions.renamedSession(previous, result.session);
      return result;
    });
  add('close_session', 'Terminate a session and all its panes. Does not delete saved resurrection data.', { session },
    (a, signal) => client.closeSession(a.session, signal), false, true);

  add('list_tabs', 'List tabs and their stable IDs and metadata.', { session },
    (a, signal) => client.listTabs(a.session, signal), true);
  add('create_tab', 'Create a tab, optionally running a command directly. Returns its stable ID without waiting for command exit.', { session, ...creation },
    (a, signal) => client.createTab(a, a.session, signal));
  add('rename_tab', 'Rename the explicitly identified tab.', { session, tab_id, name },
    (a, signal) => client.tabAction('rename', a.tab_id, a.session, a.name, signal));
  add('close_tab', 'Close a tab and its panes.', { session, tab_id },
    (a, signal) => client.tabAction('close', a.tab_id, a.session, undefined, signal), false, true);
  add('focus_tab', 'Explicitly switch the visible tab.', { session, tab_id },
    (a, signal) => client.tabAction('focus', a.tab_id, a.session, undefined, signal));

  add('list_panes', 'List typed pane IDs and metadata, optionally filtered by stable tab ID.', { session, tab_id: tab_id.optional() },
    (a, signal) => client.listPanes(a.session, a.tab_id, signal), true);
  add('create_pane', 'Create a terminal pane in a tab without focus by default. Direction is a Zellij tab placement hint, not a split of an arbitrary pane ID.', {
    session, tab_id, ...creation, direction: z.enum(['right', 'down']).optional(),
  }, (a, signal) => client.createPane(a.tab_id, a, a.session, signal));
  add('rename_pane', 'Rename the explicitly identified pane.', { session, pane_id, name },
    (a, signal) => client.paneAction('rename', a.pane_id, a.session, { name: a.name }, signal));
  add('close_pane', 'Close a pane and its process. Closing the last pane can close its tab/session.', { session, pane_id },
    (a, signal) => client.paneAction('close', a.pane_id, a.session, {}, signal), false, true);
  add('focus_pane', 'Explicitly give a pane focus.', { session, pane_id },
    (a, signal) => client.paneAction('focus', a.pane_id, a.session, {}, signal));
  add('resize_pane', 'Increase/decrease a pane by one native Zellij step, optionally at a chosen border.', {
    session, pane_id, resize: z.enum(['increase', 'decrease']).default('increase'),
    direction: z.enum(['left', 'right', 'up', 'down']).optional(),
  }, (a, signal) => client.paneAction('resize', a.pane_id, a.session, a, signal));

  add('send_text', 'Paste literal text (up to 64KiB UTF-8) using bracketed paste, optionally followed by Enter. Input is delivered to the current program, not necessarily a shell. Human input can interleave.', {
    session, pane_id, text: z.string().max(64 * 1024), enter: z.boolean().default(false),
  }, (a, signal) => client.sendText(a.pane_id, a.text, a.enter, a.session, signal), false, true);
  add('send_keys', 'Send a sequence of Zellij keys such as Enter, Ctrl c, Left, or Alt x to an explicit pane.', {
    session, pane_id, keys: z.array(z.string().min(1).max(128)).min(1).max(256),
  }, (a, signal) => client.sendKeys(a.pane_id, a.keys, a.session, signal), false, true);
  add('capture', 'Read rendered screen text without changing focus or scroll position. Optionally include scrollback; returns the most recent requested lines.', {
    session, pane_id, scrollback: z.boolean().default(false),
    lines: z.number().int().min(1).max(10_000).default(200), ansi: z.boolean().default(false),
  }, (a, signal) => client.capture(a.pane_id, a, a.session, signal), true);

  add('subscribe', 'Start collecting rendered pane updates in memory. Returns immediately; use read_events to read. Does not record raw stdout or keystrokes and does not push agent instructions.', {
    session, pane_ids: z.array(pane_id).min(1).max(256),
    scrollback_lines: z.number().int().min(0).max(10_000).default(0),
  }, (a, signal) => subscriptions.subscribe(a.pane_ids, a.session, a.scrollback_lines, signal));
  add('read_events', 'Read events after a subscription-local cursor without consuming them. Optionally wait up to 30s. gap means earlier events were evicted; next_cursor resumes reading. Other tools remain available.', {
    subscription_id: z.string().uuid(), cursor: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(1_000).default(100),
    timeout_ms: z.number().int().min(0).max(30_000).default(0),
  }, (a, signal) => subscriptions.readEvents(a.subscription_id, a.cursor, a.limit, a.timeout_ms, signal), true);
  add('unsubscribe', 'Stop a collector and release its buffer. Safe to repeat; never closes a pane. Released subscriptions can no longer be read.', {
    subscription_id: z.string().uuid(),
  }, a => subscriptions.unsubscribe(a.subscription_id));
}
