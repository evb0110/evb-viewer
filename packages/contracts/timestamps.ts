import type {TBrand} from '@contracts/brand';

export type TEpochMs = TBrand<number, 'EpochMs'>;
export type TIsoTimestamp = TBrand<string, 'IsoTimestamp'>;

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export function isEpochMs(value: unknown): value is TEpochMs {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseEpochMs(value: unknown): TEpochMs | null {
    return isEpochMs(value) ? value : null;
}

export function requireEpochMs(value: unknown): TEpochMs {
    const parsed = parseEpochMs(value);
    if (parsed === null) {
        throw new TypeError('Epoch timestamp must be a non-negative safe integer');
    }
    return parsed;
}

export function createEpochMs(value = Date.now()): TEpochMs {
    return requireEpochMs(value);
}

export function isIsoTimestamp(value: unknown): value is TIsoTimestamp {
    return typeof value === 'string' && ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

export function parseIsoTimestamp(value: unknown): TIsoTimestamp | null {
    return isIsoTimestamp(value) ? value : null;
}

export function requireIsoTimestamp(value: unknown): TIsoTimestamp {
    const parsed = parseIsoTimestamp(value);
    if (parsed === null) {
        throw new TypeError('Timestamp must be an ISO-8601 UTC string');
    }
    return parsed;
}

export function createIsoTimestamp(date = new Date()): TIsoTimestamp {
    return requireIsoTimestamp(date.toISOString());
}
