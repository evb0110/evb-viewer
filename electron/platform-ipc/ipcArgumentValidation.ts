import { IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES } from '@contracts/electronApiDocuments';

// fallow-ignore-next-line unused-export
const IPC_MAX_BINARY_PAYLOAD_BYTES = IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES;
const IPC_MAX_COLLECTION_ITEMS = 100_000;

export function decodeBoundedArray(
    value: unknown,
    fieldName: string,
    options: {
        allowEmpty?: boolean;
        maxItems?: number;
    } = {},
): unknown[] {
    const maxItems = options.maxItems ?? IPC_MAX_COLLECTION_ITEMS;
    if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
        throw new Error(`${fieldName} must be ${options.allowEmpty ? 'an' : 'a non-empty'} array`);
    }
    if (value.length > maxItems) {
        throw new Error(`${fieldName} exceeds maximum item count (${maxItems})`);
    }
    return value;
}

export function decodeStringArg(args: readonly unknown[], index: number, fieldName: string): string {
    const value = args[index];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${fieldName} must be a non-empty string`);
    }
    return value;
}

export function decodeSafeIntegerArg(args: readonly unknown[], index: number, fieldName: string, min = 0): number {
    const value = args[index];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        throw new Error(`${fieldName} must be a safe integer >= ${min}`);
    }
    return value;
}

export function decodeUint8ArrayArg(
    args: readonly unknown[],
    index: number,
    fieldName: string,
    maxBytes = IPC_MAX_BINARY_PAYLOAD_BYTES,
): Uint8Array {
    const value = args[index];
    if (!(value instanceof Uint8Array)) {
        throw new Error(`${fieldName} must be a Uint8Array`);
    }
    if (value.byteLength > maxBytes) {
        throw new Error(`${fieldName} exceeds maximum size (${maxBytes} bytes)`);
    }
    return value;
}

export function decodeStringArrayArg(args: readonly unknown[], index: number, fieldName: string): string[] {
    const items = decodeBoundedArray(args[index], fieldName, {allowEmpty: true});
    if (items.some(item => typeof item !== 'string' || item.trim().length === 0)) {
        throw new Error(`${fieldName} must be an array of non-empty strings`);
    }
    return items as string[];
}
