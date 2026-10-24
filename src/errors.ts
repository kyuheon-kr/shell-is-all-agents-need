export type ErrorCode =
  | 'INVALID_ARGUMENT' | 'ACCESS_DENIED' | 'NO_DEFAULT_SESSION'
  | 'NOT_FOUND' | 'ALREADY_EXISTS' | 'CLI_ERROR' | 'TIMEOUT'
  | 'CANCELLED' | 'BINARY_NOT_FOUND' | 'UNSUPPORTED_VERSION'
  | 'INVALID_OUTPUT' | 'RESOURCE_LIMIT';

export class ZellijError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ZellijError';
    this.code = code;
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new ZellijError(code, message);
}

export function integer(value: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_ARGUMENT', `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function literal(value: string, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || value.includes('\0')) {
    fail('INVALID_ARGUMENT', `${name} must be ${allowEmpty ? 'a' : 'a nonempty'} string without NUL`);
  }
  return value;
}

export function sessionName(value: string): string {
  literal(value, 'session');
  if (/[\r\n/\\]/u.test(value) || value === '.' || value === '..' || value.startsWith('-')) {
    fail('INVALID_ARGUMENT', 'Session names cannot contain path separators/newlines or start with a dash');
  }
  return value;
}

export function paneId(value: string): string {
  if (!/^(terminal|plugin)_\d+$/u.test(value)) {
    fail('INVALID_ARGUMENT', 'pane_id must be a typed ID such as terminal_1 or plugin_2');
  }
  return value;
}
