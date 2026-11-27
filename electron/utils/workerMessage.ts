import {isPlainObject} from 'es-toolkit/predicate';

export function isWorkerMessageRecord(value: unknown): value is Record<string, unknown> {
    return isPlainObject(value);
}

export function isFiniteWorkerMessageNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
