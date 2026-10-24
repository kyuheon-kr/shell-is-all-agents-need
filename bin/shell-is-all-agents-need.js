#!/usr/bin/env node
// Node 24 runs the erasable TypeScript sources without a build step.
import { main } from '../src/server.ts';

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
