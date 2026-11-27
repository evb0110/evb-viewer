export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ISuppressedErrorLike {
    error?: unknown;
    suppressed?: unknown;
}

export function isSuppressedErrorLike(value: unknown): value is ISuppressedErrorLike {
    if (!isRecord(value)) {
        return false;
    }
    const SuppressedErrorCtor = (globalThis as {SuppressedError?: unknown}).SuppressedError;
    return (typeof SuppressedErrorCtor === 'function' && value instanceof SuppressedErrorCtor)
        || value.name === 'SuppressedError';
}

export function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

export function isFinitePositive(value: unknown): value is number {
    return isFiniteNumber(value) && value > 0;
}

export function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
    return typeof value === 'string' && values.some(candidate => candidate === value);
}

export function isSafeWorkerRequestId(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

export interface IErrnoLikeException {
    code: string | number;
    errno?: number;
    path?: string;
    syscall?: string;
}

export function isErrnoException(value: unknown): value is IErrnoLikeException {
    return isRecord(value)
        && (typeof value.code === 'string' || typeof value.code === 'number')
        && (value.errno === undefined || typeof value.errno === 'number')
        && (value.path === undefined || typeof value.path === 'string')
        && (value.syscall === undefined || typeof value.syscall === 'string');
}
