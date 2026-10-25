import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { readRuntimeConfig } from './config.ts';
import type { Config } from './config.ts';
import { createRunner } from './runner.ts';
import type { Runner } from './runner.ts';
import { ZellijClient } from './zellij.ts';
import { SubscriptionManager } from './subscriptions.ts';
import { registerTools } from './tools.ts';
import { help, readCliConfig } from './cli.ts';
import { version } from './version.ts';
import { diagnose } from './doctor.ts';

export function createServer(config: Config = readRuntimeConfig(), runner: Runner = createRunner(config.binary)) {
  const client = new ZellijClient(config, runner);
  const subscriptions = new SubscriptionManager(client);
  const server = new McpServer({ name: 'shell-is-all-agents-need', version }, {
    instructions: 'Manage Zellij sessions, tabs and panes and interact with terminal programs. '
      + 'Use explicit stable tab IDs and typed pane IDs. Observation is rendered screen state, not a command log or human input log. '
      + 'Human users share these panes and may intervene at any time. send_text defaults to paste without Enter. '
      + 'Use subscribe and cursor-based read_events for asynchronous observation; release collectors with unsubscribe. '
      + 'A subscription does not deliver new instructions to an agent automatically. '
      + 'Do not assume a quiet screen means a process finished. No elevated privileges are needed to control your own sessions.',
  });
  registerTools(server, client, subscriptions);
  server.server.onclose = () => subscriptions.dispose();
  return { server, client, subscriptions };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = readCliConfig(args);
  if ('help' in options) { process.stdout.write(help); return; }
  if ('doctor' in options) {
    const report = await diagnose(options.args);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const { server, client, subscriptions } = createServer(options.config);
  await client.checkVersion();
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    subscriptions.dispose();
    void server.close().catch(error => { console.error(String(error)); process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown);
  await server.connect(new StdioServerTransport());
}
