import {describe, expect, it} from 'vitest';
import {getCheckedWasmMemoryView} from '@contracts/getCheckedWasmMemoryView';

describe('checked WASM linear memory spans', () => {
    it('uses the current memory buffer after growth', () => {
        const memory = new WebAssembly.Memory({initial: 1});

        expect(() => getCheckedWasmMemoryView(memory, 65_520, 32, 'Test WASM')).toThrow(
            'Test WASM returned a memory span outside linear memory',
        );

        memory.grow(1);
        const view = getCheckedWasmMemoryView(memory, 65_520, 32, 'Test WASM');
        view.fill(0xa5);
        expect(view[31]).toBe(0xa5);
    });

    it('accepts a span ending exactly at the linear-memory boundary', () => {
        const memory = new WebAssembly.Memory({initial: 1});
        const byteLength = 32;
        const pointer = memory.buffer.byteLength - byteLength;

        const view = getCheckedWasmMemoryView(memory, pointer, byteLength, 'Test WASM');

        expect(view.byteOffset).toBe(pointer);
        expect(view.byteLength).toBe(byteLength);
    });

    it.each([0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -0x8000_0001, 0x8000_0000])(
        'rejects malformed or null pointer %s',
        (pointer) => {
            const memory = new WebAssembly.Memory({initial: 1});
            const read = () => getCheckedWasmMemoryView(memory, pointer, 1, 'Test WASM');

            expect(read).toThrow(RangeError);
            expect(read).toThrow(
                pointer === 0 ? 'Test WASM returned a memory span outside linear memory' : 'Test WASM returned an invalid pointer',
            );
        },
    );

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000])('rejects malformed byte length %s', (byteLength) => {
        const memory = new WebAssembly.Memory({initial: 1});
        const read = () => getCheckedWasmMemoryView(memory, 1, byteLength, 'Test WASM');

        expect(read).toThrow(RangeError);
        expect(read).toThrow('Test WASM returned an invalid byte length');
    });
});
