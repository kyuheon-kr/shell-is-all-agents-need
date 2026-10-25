export const MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const MAX_EVENT_BYTES = 512 * 1024;

export function toolResult(output: Record<string, unknown>, isError = false) {
  return { ...(isError ? { isError: true } : {}),
    content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
}

// Include both representations and JSON escaping in the budget, leaving room
// for the JSON-RPC envelope below common hosts' 10MiB transport limit.
export function resultBytes(output: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(toolResult(output)));
}

export function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

export function boundedText<T extends Record<string, unknown>>(text: string, build: (text: string, clipped: boolean) => T): T {
  let budget = 512 * 1024;
  for (;;) {
    const tail = utf8Tail(text, budget);
    const output = build(tail, tail !== text);
    if (resultBytes(output) <= MAX_RESULT_BYTES) return output;
    budget = Math.floor(budget / 2);
    if (budget === 0) throw new Error('Response metadata exceeds its byte budget');
  }
}
