const IPC_DEFAULT_STRING_MAX_LENGTH = 512;
export const IPC_FILENAME_MAX_LENGTH = 255;
const IPC_REQUEST_ID_MAX_LENGTH = 128;

export function normalizeBoundedString(
    value: unknown,
    fieldName: string,
    maxLength = IPC_DEFAULT_STRING_MAX_LENGTH,
) {
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string`);
    }
    const normalized = value.trim();
    if (!normalized) {
        throw new Error(`${fieldName} must not be empty`);
    }
    if (normalized.length > maxLength) {
        throw new Error(`${fieldName} exceeds maximum length (${maxLength})`);
    }
    return normalized;
}

export function normalizeOptionalIpcRequestId(value: unknown, fieldName = 'requestId') {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value === 'string' && value.trim().length === 0) {
        return undefined;
    }
    return normalizeBoundedString(value, fieldName, IPC_REQUEST_ID_MAX_LENGTH);
}

export function truncateForIpc(value: string, maxLength = IPC_DEFAULT_STRING_MAX_LENGTH) {
    return value.length <= maxLength ? value : value.slice(0, maxLength);
}
