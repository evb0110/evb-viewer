function toBridgeSafeValue(value: unknown, depth: number): unknown {
    if (depth > 32) {
        throw new Error('scan-cleanup payload exceeds supported depth');
    }
    const raw: unknown = toRaw(value);
    if (raw === null || typeof raw !== 'object') {
        return raw;
    }
    if (Array.isArray(raw)) {
        return raw.map((entry) => toBridgeSafeValue(entry, depth + 1));
    }
    if (raw instanceof Map) {
        return Object.fromEntries([...raw.entries()].map(([key, entry]) => [String(key), toBridgeSafeValue(entry, depth + 1)]));
    }
    if (raw instanceof Set) {
        return [...raw.values()].map((entry) => toBridgeSafeValue(entry, depth + 1));
    }
    const prototype: unknown = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`scan-cleanup payload contains a non-plain object (${Object.prototype.toString.call(raw)})`);
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(raw)) {
        if (entry === undefined) {
            continue;
        }
        result[key] = toBridgeSafeValue(entry, depth + 1);
    }
    return result;
}

/**
 * Rebuilds a scan-cleanup IPC payload as plain data before it crosses the
 * contextBridge. The bridge rejects Maps, Sets, class instances, and reactive
 * proxies with "An object could not be cloned", and that crossing happens
 * before any preload-side encoding can intervene.
 */
export function toBridgeSafeScanCleanupPayload<T>(payload: T): T {
    return toBridgeSafeValue(payload, 0) as T;
}
