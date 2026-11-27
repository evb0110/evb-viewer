const WASM_I32_MIN = -0x8000_0000;
const WASM_I32_MAX = 0x7fff_ffff;
const WASM_U32_MAX = 0xffff_ffff;

export const WASM_REQUEST_ALLOCATION_ABI_VERSION = 1;

/**
 * Returns a bounded view into the current WASM linear-memory buffer.
 * Consume the view immediately. Do not retain it across any WASM export call,
 * because memory growth replaces the underlying buffer and invalidates prior views.
 */
export function getCheckedWasmMemoryView(memory: WebAssembly.Memory, pointer: number, byteLength: number, label: string) {
    if (!Number.isInteger(pointer) || pointer < WASM_I32_MIN || pointer > WASM_I32_MAX) {
        throw new RangeError(`${label} returned an invalid pointer`);
    }
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > WASM_U32_MAX) {
        throw new RangeError(`${label} returned an invalid byte length`);
    }

    const unsignedPointer = pointer >>> 0;
    const end = unsignedPointer + byteLength;
    if (unsignedPointer === 0 || end > WASM_U32_MAX + 1 || end > memory.buffer.byteLength) {
        throw new RangeError(`${label} returned a memory span outside linear memory`);
    }

    return new Uint8Array(memory.buffer, unsignedPointer, byteLength);
}
