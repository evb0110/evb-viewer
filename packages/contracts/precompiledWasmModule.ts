export const PRECOMPILED_WASM_MODULE_MESSAGE_TYPE = 'evb:precompiled-wasm-module';

export interface IPrecompiledWasmModuleMessage {
    type: typeof PRECOMPILED_WASM_MODULE_MESSAGE_TYPE;
    path: string;
    module: WebAssembly.Module;
    digest: string | null;
}

export function isRealWasmModule(value: unknown): value is WebAssembly.Module {
    return typeof WebAssembly !== 'undefined'
        && typeof WebAssembly.Module === 'function'
        && value instanceof WebAssembly.Module;
}

/**
 * Validates an incoming worker control message carrying a precompiled
 * `WebAssembly.Module`. Returns the typed message when valid, `null` when
 * the message is not a preload message or has invalid fields.
 */
export function parsePrecompiledWasmModuleMessage(data: unknown): IPrecompiledWasmModuleMessage | null {
    if (typeof data !== 'object' || data === null) {return null;}
    const record = data as Record<string, unknown>;
    if (record.type !== PRECOMPILED_WASM_MODULE_MESSAGE_TYPE) {return null;}
    if (typeof record.path !== 'string' || record.path.length === 0 || !isRealWasmModule(record.module)) {
        return null;
    }
    const digest = typeof record.digest === 'string' && record.digest.length > 0
        ? record.digest
        : null;
    return {
        type: PRECOMPILED_WASM_MODULE_MESSAGE_TYPE,
        path: record.path,
        module: record.module,
        digest,
    };
}
