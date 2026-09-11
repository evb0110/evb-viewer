import {
    isNil,
    isString,
} from 'es-toolkit/predicate';
import { trim } from 'es-toolkit/string';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';

export const MAX_IPC_PATH_LENGTH = 4_096;

export function assertNonEmptyString(value: unknown, fieldName: string, maxLength = MAX_IPC_PATH_LENGTH) {
    if (!isString(value)) {
        throw new Error(`${fieldName} must be a string`);
    }

    const normalized = trim(value);
    if (!normalized) {
        throw new Error(`${fieldName} must not be empty`);
    }
    if (normalized.length > maxLength) {
        throw new Error(`${fieldName} exceeds maximum length (${maxLength})`);
    }
    if (normalized.includes('\0')) {
        throw new Error(`${fieldName} must not contain NUL bytes`);
    }

    return normalized;
}

export function isLikelyAbsolutePath(path: string) {
    return path.startsWith('/')
        || path.startsWith('\\\\')
        || /^[A-Za-z]:[\\/]/.test(path);
}

export function assertAbsolutePath(value: unknown, fieldName: string): TDocumentRef {
    if (!isString(value)) {
        throw new Error(`${fieldName} must be a string`);
    }
    if (!value.trim()) {
        throw new Error(`${fieldName} must not be empty`);
    }
    if (value.length > MAX_IPC_PATH_LENGTH) {
        throw new Error(`${fieldName} exceeds maximum length (${MAX_IPC_PATH_LENGTH})`);
    }
    if (value.includes('\0')) {
        throw new Error(`${fieldName} must not contain NUL bytes`);
    }
    const normalized = value;
    if (!isLikelyAbsolutePath(normalized)) {
        throw new Error(`${fieldName} must be an absolute path`);
    }
    return parseDocumentRef(normalized) ?? (() => {
        throw new Error(`${fieldName} must be a supported document reference`);
    })();
}

export function assertOptionalAbsolutePath(value: unknown, fieldName: string): TDocumentRef | undefined {
    if (isNil(value)) {
        return undefined;
    }

    if (isString(value) && trim(value).length === 0) {
        return undefined;
    }

    const normalized = assertNonEmptyString(value, fieldName);
    if (!isLikelyAbsolutePath(normalized)) {
        throw new Error(`${fieldName} must be an absolute path`);
    }
    return parseDocumentRef(normalized) ?? (() => {
        throw new Error(`${fieldName} must be a supported document reference`);
    })();
}
