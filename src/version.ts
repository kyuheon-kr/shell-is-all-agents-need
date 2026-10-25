import { readFileSync } from 'node:fs';

// Both src/ and the published dist/ sit next to the same package manifest.
export const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
