import {closeSync, ftruncateSync, linkSync, openSync, readFileSync, symlinkSync, writeFileSync, writeSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {WASM_REQUEST_ALLOCATION_ABI_VERSION} from '@contracts/getCheckedWasmMemoryView';
import {createPdfPageOpsWasmRunner, HostSourceReadCache, type IHostIoContext} from '@node-runtime/pdfPageOpsWasmRunner';

/**
 * Minimal hand-assembled WebAssembly module that implements the EVB allocation
 * ABI and dispatches one host-I/O test command per `runFileRequest`:
 *
 * Request binary layout (little-endian):
 *   u32 op:
 *     1 = source_read(sourceIndex, offset, len) -> output = read bytes
 *     2 = sink_write(at, payloadBytes) -> output = [0]
 *     3 = source_copy(sourceIndex, offset, len, at) -> output = [0]
 *     4 = sink_read(offset, len) -> output = read bytes
 *     5 = source_len(sourceIndex) -> output = f64 length (8 bytes LE)
 *     6 = source_read -> sink_write -> source_read (same command!)
 *     7 = source_read -> source_copy -> source_read (same command!)
 *     8 = source_read -> sink_write -> sink_read (same command!)
 *     9 = source_read -> sink_write -> source_len -> source_read (same command!)
 *
 * To keep the WASM bytecode tiny and auditable, it runs a sequence of fixed
 * 24-byte instructions in a loop:
 *   offset  0: i32 opcode (1=source_read, 2=sink_write, 3=source_copy, 4=sink_read, 5=source_len)
 *   offset  4: i32 arg0 (sourceIndex or writeOffset)
 *   offset  8: i32 arg1 (offset/at)
 *   offset 12: i32 arg2 (len)
 *   offset 16: i32 arg3 (at for source_copy, or payloadOffset in request for sink_write)
 *   offset 20: i32 flags (bit 0: expect failure (-1), do not abort)
 *
 * Output buffer starts at linear memory offset 32768 (0x8000):
 *   For each instruction, appends 4-byte i32 status followed by read bytes (if op 1/4 and status==0)
 *   or 8-byte f64 length (if op 5).
 */
function encodeUleb128(value: number): number[] {
    const out: number[] = [];
    let v = value >>> 0;
    do {
        let byte = v & 0x7f;
        v >>>= 7;
        if (v !== 0) {
            byte |= 0x80;
        }
        out.push(byte);
    } while (v !== 0);
    return out;
}

function encodeSleb128(value: number): number[] {
    const out: number[] = [];
    let v = value | 0;
    let more = true;
    while (more) {
        let byte = v & 0x7f;
        v >>= 7;
        if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
            more = false;
        } else {
            byte |= 0x80;
        }
        out.push(byte);
    }
    return out;
}

function encodeString(text: string): number[] {
    const bytes = [...new TextEncoder().encode(text)];
    return [...encodeUleb128(bytes.length), ...bytes];
}

function encodeSection(id: number, body: number[]): number[] {
    return [id, ...encodeUleb128(body.length), ...body];
}

function encodeVec(items: number[][]): number[] {
    return [...encodeUleb128(items.length), ...items.flat()];
}

const I32 = 0x7f;
const F64 = 0x7c;

function buildHostIoProbeWasmModule(): WebAssembly.Module {
    // Types:
    // 0: () -> i32
    // 1: (i32) -> i32
    // 2: (i32, i32) -> ()
    // 3: (i32, i32) -> i32
    // 4: (i32) -> f64                      [evb_host_source_len]
    // 5: (i32, f64, i32, i32) -> i32       [evb_host_source_read]
    // 6: (i32, f64, f64, f64) -> i32       [evb_host_source_copy]
    // 7: (f64, i32, i32) -> i32            [evb_host_sink_write / evb_host_sink_read]
    const types = [
        [0x60, 0, 1, I32],
        [0x60, 1, I32, 1, I32],
        [0x60, 2, I32, I32, 0],
        [0x60, 2, I32, I32, 1, I32],
        [0x60, 1, I32, 1, F64],
        [0x60, 4, I32, F64, I32, I32, 1, I32],
        [0x60, 4, I32, F64, F64, F64, 1, I32],
        [0x60, 3, F64, I32, I32, 1, I32],
    ];

    // Imports (func indices 0..4):
    // 0: evb_host.evb_host_source_len (type 4)
    // 1: evb_host.evb_host_source_read (type 5)
    // 2: evb_host.evb_host_source_copy (type 6)
    // 3: evb_host.evb_host_sink_write (type 7)
    // 4: evb_host.evb_host_sink_read (type 7)
    const imports = [
        [...encodeString('evb_host'), ...encodeString('evb_host_source_len'), 0x00, 4],
        [...encodeString('evb_host'), ...encodeString('evb_host_source_read'), 0x00, 5],
        [...encodeString('evb_host'), ...encodeString('evb_host_source_copy'), 0x00, 6],
        [...encodeString('evb_host'), ...encodeString('evb_host_sink_write'), 0x00, 7],
        [...encodeString('evb_host'), ...encodeString('evb_host_sink_read'), 0x00, 7],
    ];

    // Defined functions (indices 5..12):
    // 5: evb_wasm_request_allocation_abi_version (type 0)
    // 6: evb_pdf_page_ops_alloc (type 1)
    // 7: evb_pdf_page_ops_free (type 2)
    // 8: evb_pdf_page_ops_run (type 3)
    // 9: evb_pdf_page_ops_output_ptr (type 0)
    // 10: evb_pdf_page_ops_output_len (type 0)
    // 11: evb_pdf_page_ops_error_ptr (type 0)
    // 12: evb_pdf_page_ops_error_len (type 0)
    const funcTypes = [0, 1, 2, 3, 0, 0, 0, 0];

    // Memory: 2 pages (128 KiB).
    // Request buffer at 4096 (0x1000), output buffer at 32768 (0x8000).
    // Global 0 (mut i32): lastOutputLen
    const globals = [[I32, 0x01, 0x41, ...encodeSleb128(0), 0x0b]];

    const exportsList = [
        [...encodeString('memory'), 0x02, 0],
        [...encodeString('evb_wasm_request_allocation_abi_version'), 0x00, 5],
        [...encodeString('evb_pdf_page_ops_alloc'), 0x00, 6],
        [...encodeString('evb_pdf_page_ops_free'), 0x00, 7],
        [...encodeString('evb_pdf_page_ops_run'), 0x00, 8],
        [...encodeString('evb_pdf_page_ops_output_ptr'), 0x00, 9],
        [...encodeString('evb_pdf_page_ops_output_len'), 0x00, 10],
        [...encodeString('evb_pdf_page_ops_error_ptr'), 0x00, 11],
        [...encodeString('evb_pdf_page_ops_error_len'), 0x00, 12],
    ];

    const encodeBody = (locals: Array<[number, number]>, code: number[]) => {
        const body = [...encodeVec(locals.map(([count, ty]) => [...encodeUleb128(count), ty])), ...code, 0x0b];
        return [...encodeUleb128(body.length), ...body];
    };

    const i32Const = (n: number) => [0x41, ...encodeSleb128(n)];
    const localGet = (idx: number) => [0x20, ...encodeUleb128(idx)];
    const localSet = (idx: number) => [0x21, ...encodeUleb128(idx)];
    const localTee = (idx: number) => [0x22, ...encodeUleb128(idx)];
    const globalGet = (idx: number) => [0x23, ...encodeUleb128(idx)];
    const globalSet = (idx: number) => [0x24, ...encodeUleb128(idx)];
    const i32Load = (offset: number) => [0x28, 0x02, ...encodeUleb128(offset)];
    const i32Store = (offset: number) => [0x36, 0x02, ...encodeUleb128(offset)];
    const f64Store = (offset: number) => [0x39, 0x03, ...encodeUleb128(offset)];
    const call = (idx: number) => [0x10, ...encodeUleb128(idx)];

    // Function 8: run(reqPtr: local 0, reqLen: local 1) -> i32
    // Request header:
    //   [0..4]: i32 count (number of 24-byte instructions starting at reqPtr + 4)
    //   [4 .. 4 + count * 24]: instructions
    //   [4 + count * 24 ..]: raw payload bytes referenced by arg3 (offset from reqPtr)
    // Locals:
    //   2: i (instruction index)
    //   3: count
    //   4: instPtr
    //   5: outCursor (absolute pointer in memory, starts at 32768)
    //   6: op
    //   7: status
    //   8: len
    const runCode: number[] = [
        // count = i32.load(reqPtr)
        ...localGet(0),
        ...i32Load(0),
        ...localSet(3),
        // i = 0
        ...i32Const(0),
        ...localSet(2),
        // outCursor = 32768
        ...i32Const(32768),
        ...localSet(5),
        // block $done
        0x02,
        0x40,
        // loop $loop
        0x03,
        0x40,
        // if i >= count: br $done
        ...localGet(2),
        ...localGet(3),
        0x4e, // i32.ge_s
        0x0d,
        1,
        // instPtr = reqPtr + 4 + i * 24
        ...localGet(0),
        ...i32Const(4),
        0x6a, // i32.add
        ...localGet(2),
        ...i32Const(24),
        0x6c, // i32.mul
        0x6a, // i32.add
        ...localSet(4),
        // op = load(instPtr + 0)
        ...localGet(4),
        ...i32Load(0),
        ...localSet(6),
        // len = load(instPtr + 12)
        ...localGet(4),
        ...i32Load(12),
        ...localSet(8),

        // if op == 1 (source_read):
        ...localGet(6),
        ...i32Const(1),
        0x46, // i32.eq
        0x04,
        0x40,
        // status = evb_host_source_read(arg0, f64(arg1), outCursor + 4, len)
        ...localGet(4),
        ...i32Load(4),
        ...localGet(4),
        ...i32Load(8),
        0xb8, // f64.convert_i32_u
        ...localGet(5),
        ...i32Const(4),
        0x6a,
        ...localGet(8),
        ...call(1),
        ...localSet(7),
        // store status at outCursor
        ...localGet(5),
        ...localGet(7),
        ...i32Store(0),
        // outCursor += 4 + (status == 0 ? len : 0)
        ...localGet(5),
        ...i32Const(4),
        0x6a,
        ...localSet(5),
        ...localGet(7),
        0x45, // i32.eqz
        0x04,
        0x40,
        ...localGet(5),
        ...localGet(8),
        0x6a,
        ...localSet(5),
        0x0b, // end if status == 0
        0x0b, // end if op == 1

        // if op == 2 (sink_write):
        ...localGet(6),
        ...i32Const(2),
        0x46,
        0x04,
        0x40,
        // status = evb_host_sink_write(f64(arg1), reqPtr + arg3, len)
        ...localGet(4),
        ...i32Load(8),
        0xb8,
        ...localGet(0),
        ...localGet(4),
        ...i32Load(16),
        0x6a,
        ...localGet(8),
        ...call(3),
        ...localSet(7),
        ...localGet(5),
        ...localGet(7),
        ...i32Store(0),
        ...localGet(5),
        ...i32Const(4),
        0x6a,
        ...localSet(5),
        0x0b,

        // if op == 3 (source_copy):
        ...localGet(6),
        ...i32Const(3),
        0x46,
        0x04,
        0x40,
        // status = evb_host_source_copy(arg0, f64(arg1), f64(len), f64(arg3))
        ...localGet(4),
        ...i32Load(4),
        ...localGet(4),
        ...i32Load(8),
        0xb8,
        ...localGet(8),
        0xb8,
        ...localGet(4),
        ...i32Load(16),
        0xb8,
        ...call(2),
        ...localSet(7),
        ...localGet(5),
        ...localGet(7),
        ...i32Store(0),
        ...localGet(5),
        ...i32Const(4),
        0x6a,
        ...localSet(5),
        0x0b,

        // if op == 4 (sink_read):
        ...localGet(6),
        ...i32Const(4),
        0x46,
        0x04,
        0x40,
        // status = evb_host_sink_read(f64(arg1), outCursor + 4, len)
        ...localGet(4),
        ...i32Load(8),
        0xb8,
        ...localGet(5),
        ...i32Const(4),
        0x6a,
        ...localGet(8),
        ...call(4),
        ...localSet(7),
        ...localGet(5),
        ...localGet(7),
        ...i32Store(0),
        ...localGet(5),
        ...i32Const(4),
        0x6a,
        ...localSet(5),
        ...localGet(7),
        0x45,
        0x04,
        0x40,
        ...localGet(5),
        ...localGet(8),
        0x6a,
        ...localSet(5),
        0x0b,
        0x0b,

        // if op == 5 (source_len):
        ...localGet(6),
        ...i32Const(5),
        0x46,
        0x04,
        0x40,
        // store status=0 at outCursor, store f64 len at outCursor + 4, advance 12
        ...localGet(5),
        ...i32Const(0),
        ...i32Store(0),
        ...localGet(5),
        ...localGet(4),
        ...i32Load(4),
        ...call(0),
        ...f64Store(4),
        ...localGet(5),
        ...i32Const(12),
        0x6a,
        ...localSet(5),
        0x0b,

        // i += 1; br $loop
        ...localGet(2),
        ...i32Const(1),
        0x6a,
        ...localSet(2),
        0x0c,
        0,
        0x0b, // end loop
        0x0b, // end block
        // lastOutputLen = outCursor - 32768
        ...localGet(5),
        ...i32Const(32768),
        0x6b, // i32.sub
        ...localTee(7),
        ...globalSet(0),
        ...i32Const(0),
    ];

    const bodies = [
        encodeBody([], i32Const(WASM_REQUEST_ALLOCATION_ABI_VERSION)),
        encodeBody([], i32Const(4096)),
        encodeBody([], []),
        encodeBody([[7, I32]], runCode),
        encodeBody([], i32Const(32768)),
        encodeBody([], globalGet(0)),
        encodeBody([], i32Const(0)),
        encodeBody([], i32Const(0)),
    ];

    const bytes = [
        0x00,
        0x61,
        0x73,
        0x6d,
        0x01,
        0x00,
        0x00,
        0x00,
        ...encodeSection(1, encodeVec(types)),
        ...encodeSection(2, encodeVec(imports)),
        ...encodeSection(3, encodeVec(funcTypes.map((t) => [t]))),
        ...encodeSection(5, encodeVec([[0x00, 2]])),
        ...encodeSection(6, encodeVec(globals)),
        ...encodeSection(7, encodeVec(exportsList)),
        ...encodeSection(10, encodeVec(bodies)),
    ];
    return new WebAssembly.Module(new Uint8Array(bytes));
}

type TProbeInstruction =
    | {op: 'source_read'; sourceIndex: number; offset: number; len: number}
    | {op: 'sink_write'; at: number; bytes: Uint8Array}
    | {op: 'source_copy'; sourceIndex: number; offset: number; len: number; at: number}
    | {op: 'sink_read'; offset: number; len: number}
    | {op: 'source_len'; sourceIndex: number};

function encodeProbeScript(instructions: readonly TProbeInstruction[]): Uint8Array {
    const headerBytes = 4 + instructions.length * 24;
    let payloadBytes = 0;
    for (const inst of instructions) {
        if (inst.op === 'sink_write') {
            payloadBytes += inst.bytes.byteLength;
        }
    }
    const buf = new Uint8Array(headerBytes + payloadBytes);
    const view = new DataView(buf.buffer);
    view.setInt32(0, instructions.length, true);
    let payloadCursor = headerBytes;
    for (let i = 0; i < instructions.length; i += 1) {
        const base = 4 + i * 24;
        const inst = instructions[i]!;
        switch (inst.op) {
            case 'source_read':
                view.setInt32(base + 0, 1, true);
                view.setInt32(base + 4, inst.sourceIndex, true);
                view.setInt32(base + 8, inst.offset, true);
                view.setInt32(base + 12, inst.len, true);
                break;
            case 'sink_write':
                view.setInt32(base + 0, 2, true);
                view.setInt32(base + 8, inst.at, true);
                view.setInt32(base + 12, inst.bytes.byteLength, true);
                view.setInt32(base + 16, payloadCursor, true);
                buf.set(inst.bytes, payloadCursor);
                payloadCursor += inst.bytes.byteLength;
                break;
            case 'source_copy':
                view.setInt32(base + 0, 3, true);
                view.setInt32(base + 4, inst.sourceIndex, true);
                view.setInt32(base + 8, inst.offset, true);
                view.setInt32(base + 12, inst.len, true);
                view.setInt32(base + 16, inst.at, true);
                break;
            case 'sink_read':
                view.setInt32(base + 0, 4, true);
                view.setInt32(base + 8, inst.offset, true);
                view.setInt32(base + 12, inst.len, true);
                break;
            case 'source_len':
                view.setInt32(base + 0, 5, true);
                view.setInt32(base + 4, inst.sourceIndex, true);
                break;
        }
    }
    return buf;
}

function decodeProbeOutput(instructions: readonly TProbeInstruction[], output: Uint8Array) {
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    let cursor = 0;
    return instructions.map((inst) => {
        const status = view.getInt32(cursor, true);
        cursor += 4;
        if (inst.op === 'source_read' || inst.op === 'sink_read') {
            if (status === 0) {
                const bytes = output.slice(cursor, cursor + inst.len);
                cursor += inst.len;
                return {op: inst.op, status, bytes};
            }
            return {op: inst.op, status, bytes: new Uint8Array(0)};
        }
        if (inst.op === 'source_len') {
            const length = view.getFloat64(cursor, true);
            cursor += 8;
            return {op: inst.op, status, length};
        }
        return {op: inst.op, status};
    });
}

describe('pdfPageOpsWasmRunner command-local LRU read block cache & invalidation invariants', () => {
    const probeModule = buildHostIoProbeWasmModule();
    let tempDir = '';

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, {recursive: true, force: true});
            tempDir = '';
        }
    });

    it('enforces LRU capacity, partial tail refresh, and range/from invalidation on HostSourceReadCache', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-read-cache-unit-'));
        const filePath = join(tempDir, 'data.bin');
        const initial = new Uint8Array(64 * 6 + 10);
        for (let i = 0; i < initial.length; i += 1) {
            initial[i] = i & 0xff;
        }
        writeFileSync(filePath, initial);

        const fd = openSync(filePath, 'r+');
        try {
            const cache = new HostSourceReadCache(64, 3);
            const out = new Uint8Array(16);

            // Populate 3 blocks (0, 1, 2) -> fills capacity 3.
            expect(cache.readExact(0, fd, out, 0)).toBe(true);
            expect(out).toEqual(initial.subarray(0, 16));
            expect(cache.readExact(0, fd, out, 64)).toBe(true);
            expect(cache.readExact(0, fd, out, 128)).toBe(true);
            expect(cache.size).toBe(3);

            // Touch block 0 so block 1 becomes LRU (FIFO would evict block 0 instead),
            // then load block 3 -> block 1 must be evicted while block 0 stays cached.
            expect(cache.readExact(0, fd, out, 8)).toBe(true);
            expect(cache.readExact(0, fd, out, 192)).toBe(true);
            expect(cache.size).toBe(3);

            // Mutate blocks 0 and 1 directly on disk WITHOUT invalidating the cache to
            // prove block 0 is still served from cache (LRU) while block 1 was evicted.
            const diskMarker0 = Buffer.alloc(16, 0xee);
            const diskMarker1 = Buffer.alloc(16, 0xdd);
            writeSync(fd, diskMarker0, 0, 16, 0);
            writeSync(fd, diskMarker1, 0, 16, 64);
            expect(cache.readExact(0, fd, out, 0)).toBe(true);
            expect(out).toEqual(initial.subarray(0, 16));
            expect(cache.readExact(0, fd, out, 64)).toBe(true);
            expect(out).toEqual(new Uint8Array(diskMarker1));
            // Restore original bytes on disk before remaining checks.
            writeSync(fd, initial, 0, 16, 0);
            writeSync(fd, initial, 64, 16, 64);
            cache.invalidateRange(0, 0, 128);

            // Cross-block read spanning block 2 and block 3 returns exact bytes.
            const span = new Uint8Array(20);
            expect(cache.readExact(0, fd, span, 184)).toBe(true);
            expect(span).toEqual(initial.subarray(184, 204));

            // Truncation invalidation: truncate file to 100 bytes, invalidateFrom(0, 100),
            // reading past 100 must fail closed.
            ftruncateSync(fd, 100);
            cache.invalidateFrom(0, 100);
            expect(cache.readExact(0, fd, out, 96)).toBe(false);
            expect(cache.readExact(0, fd, out, 84)).toBe(true);
            expect(out).toEqual(initial.subarray(84, 100));

            // Reads >= blockBytes bypass cache without polluting LRU.
            const big = new Uint8Array(64);
            expect(cache.readExact(0, fd, big, 0)).toBe(true);
            expect(big).toEqual(initial.subarray(0, 64));
        } finally {
            closeSync(fd);
        }
    });

    it('never leaks cached bytes across separate commands (command-local isolation)', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-read-cache-isolation-'));
        const filePath = join(tempDir, 'doc.bin');
        writeFileSync(filePath, Buffer.from('AAAA-1111-initial-content', 'ascii'));

        const runner = createPdfPageOpsWasmRunner(probeModule, {readCacheBlockBytes: 64, readCacheMaxBlocks: 4});
        const fd = openSync(filePath, 'r');
        try {
            const io: IHostIoContext = {
                sources: [{fd, len: 25, path: filePath}],
                extraOpenOrder: [],
                sink: null,
                memory: null,
            };
            const script: TProbeInstruction[] = [{op: 'source_read', sourceIndex: 0, offset: 0, len: 9}];
            const r1 = decodeProbeOutput(script, runner.runFileRequest(encodeProbeScript(script), io));
            expect(new TextDecoder().decode(r1[0]!.bytes)).toBe('AAAA-1111');

            // Modify the file on disk between commands.
            writeFileSync(filePath, Buffer.from('BBBB-2222-updated-content', 'ascii'));

            const r2 = decodeProbeOutput(script, runner.runFileRequest(encodeProbeScript(script), io));
            expect(new TextDecoder().decode(r2[0]!.bytes)).toBe('BBBB-2222');
        } finally {
            closeSync(fd);
            runner.dispose();
        }
    });

    it('invalidates overlapping blocks on evb_host_sink_write across in-place, hardlink, and symlink aliases', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-read-cache-write-alias-'));
        const realPath = join(tempDir, 'real.bin');
        const hardlinkPath = join(tempDir, 'hardlink.bin');
        const symlinkPath = join(tempDir, 'symlink.bin');
        const initial = Buffer.alloc(256, 0x41); // 'A' * 256
        writeFileSync(realPath, initial);
        linkSync(realPath, hardlinkPath);
        symlinkSync(realPath, symlinkPath);

        const runner = createPdfPageOpsWasmRunner(probeModule, {readCacheBlockBytes: 64, readCacheMaxBlocks: 8});
        try {
            for (const sourceAliasPath of [realPath, hardlinkPath, symlinkPath]) {
                writeFileSync(realPath, Buffer.alloc(256, 0x41));
                const srcFd = openSync(sourceAliasPath, 'r');
                const sinkFd = openSync(realPath, 'r+');
                try {
                    const io: IHostIoContext = {
                        sources: [{fd: srcFd, len: 256, path: sourceAliasPath}],
                        extraOpenOrder: [],
                        sink: {
                            fd: sinkFd,
                            path: realPath,
                            inPlace: true,
                            originalLen: 256,
                            baseSourceLen: 0,
                            baseCopied: true,
                            writtenAny: false,
                            maxLen: 256,
                        },
                        memory: null,
                    };
                    const patch = new TextEncoder().encode('PATCHED-ACROSS-64B-BOUNDARY!!');
                    // Overlap spans block 0 [0..64) and block 1 [64..128) at offset 50..79.
                    const script: TProbeInstruction[] = [
                        {op: 'source_read', sourceIndex: 0, offset: 48, len: 36},
                        {op: 'sink_write', at: 50, bytes: patch},
                        {op: 'source_read', sourceIndex: 0, offset: 48, len: 36},
                    ];
                    const results = decodeProbeOutput(script, runner.runFileRequest(encodeProbeScript(script), io));
                    expect(new TextDecoder().decode(results[0]!.bytes)).toBe('A'.repeat(36));
                    expect(results[1]!.status).toBe(0);
                    expect(new TextDecoder().decode(results[2]!.bytes)).toBe(`AA${new TextDecoder().decode(patch)}AAAAA`);
                } finally {
                    closeSync(srcFd);
                    closeSync(sinkFd);
                }
            }
        } finally {
            runner.dispose();
        }
    });

    it('invalidates aliased source blocks on evb_host_source_copy overwrite', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-read-cache-source-copy-'));
        const targetPath = join(tempDir, 'target.bin');
        const donorPath = join(tempDir, 'donor.bin');
        writeFileSync(targetPath, Buffer.alloc(128, 0x30)); // '0' * 128
        writeFileSync(donorPath, Buffer.from('COPIED-FROM-DONOR-SOURCE-BYTES!!', 'ascii'));

        const runner = createPdfPageOpsWasmRunner(probeModule, {readCacheBlockBytes: 64, readCacheMaxBlocks: 8});
        const targetFd = openSync(targetPath, 'r');
        const sinkFd = openSync(targetPath, 'r+');
        const io: IHostIoContext = {
            sources: [
                {fd: targetFd, len: 128, path: targetPath},
                {fd: null, len: null, path: donorPath},
            ],
            extraOpenOrder: [],
            sink: {
                fd: sinkFd,
                path: targetPath,
                inPlace: true,
                originalLen: 128,
                baseSourceLen: 0,
                baseCopied: true,
                writtenAny: false,
                maxLen: 128,
            },
            memory: null,
        };
        try {
            const script: TProbeInstruction[] = [
                {op: 'source_read', sourceIndex: 0, offset: 56, len: 32},
                {op: 'source_copy', sourceIndex: 1, offset: 0, len: 32, at: 56},
                {op: 'source_read', sourceIndex: 0, offset: 56, len: 32},
            ];
            const results = decodeProbeOutput(script, runner.runFileRequest(encodeProbeScript(script), io));
            expect(new TextDecoder().decode(results[0]!.bytes)).toBe('0'.repeat(32));
            expect(results[1]!.status).toBe(0);
            expect(new TextDecoder().decode(results[2]!.bytes)).toBe('COPIED-FROM-DONOR-SOURCE-BYTES!!');
        } finally {
            closeSync(targetFd);
            closeSync(sinkFd);
            if (io.sources[1]?.fd !== null && io.sources[1]?.fd !== undefined) {
                closeSync(io.sources[1].fd);
            }
            runner.dispose();
        }
    });

    it('invalidates cached partial tail block and source length on extension past EOF', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-read-cache-extend-'));
        const filePath = join(tempDir, 'extend.bin');
        writeFileSync(filePath, Buffer.from('0123456789', 'ascii')); // 10 bytes

        const runner = createPdfPageOpsWasmRunner(probeModule, {readCacheBlockBytes: 64, readCacheMaxBlocks: 4});
        const srcFd = openSync(filePath, 'r');
        const sinkFd = openSync(filePath, 'r+');
        try {
            const io: IHostIoContext = {
                sources: [{fd: srcFd, len: 10, path: filePath}],
                extraOpenOrder: [],
                sink: {
                    fd: sinkFd,
                    path: filePath,
                    inPlace: true,
                    originalLen: 10,
                    baseSourceLen: 0,
                    baseCopied: true,
                    writtenAny: false,
                    maxLen: 10,
                },
                memory: null,
            };
            const tail = new TextEncoder().encode('TAIL!');
            const script: TProbeInstruction[] = [
                // Populates partial tail block 0 (validLen=10).
                {op: 'source_read', sourceIndex: 0, offset: 0, len: 10},
                // Write at offset 20 (extends with zero-fill [10..20) + 'TAIL!' [20..25)).
                {op: 'sink_write', at: 20, bytes: tail},
                // Length must reflect new 25-byte size.
                {op: 'source_len', sourceIndex: 0},
                // Reading across [8..25) must see '89' + 10 NULs + 'TAIL!'.
                {op: 'source_read', sourceIndex: 0, offset: 8, len: 17},
            ];
            const results = decodeProbeOutput(script, runner.runFileRequest(encodeProbeScript(script), io));
            expect(new TextDecoder().decode(results[0]!.bytes)).toBe('0123456789');
            expect(results[1]!.status).toBe(0);
            expect(results[2]!.length).toBe(25);
            expect(results[3]!.status).toBe(0);
            expect(results[3]!.bytes).toEqual(Uint8Array.from([0x38, 0x39, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...tail]));
        } finally {
            closeSync(srcFd);
            closeSync(sinkFd);
            runner.dispose();
        }
    });

    it('invalidates cached blocks on truncating w+ sink open aliasing a source', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-read-cache-truncate-'));
        const filePath = join(tempDir, 'trunc.bin');
        writeFileSync(filePath, Buffer.from('OLD-CONTENT-LONGER-THAN-NEW-BYTES', 'ascii'));

        const runner = createPdfPageOpsWasmRunner(probeModule, {readCacheBlockBytes: 64, readCacheMaxBlocks: 4});
        const srcFd = openSync(filePath, 'r');
        try {
            const io: IHostIoContext = {
                sources: [{fd: srcFd, len: 33, path: filePath}],
                extraOpenOrder: [],
                sink: {
                    fd: null, // lazily opened with 'w+' (truncates filePath to 0!)
                    path: filePath,
                    inPlace: false,
                    originalLen: 0,
                    baseSourceLen: 0,
                    baseCopied: false,
                    writtenAny: false,
                    maxLen: 0,
                },
                memory: null,
            };
            const replacement = new TextEncoder().encode('SHORT');
            const script: TProbeInstruction[] = [
                {op: 'source_read', sourceIndex: 0, offset: 0, len: 11},
                {op: 'sink_write', at: 0, bytes: replacement},
                // Reading past new 5-byte EOF must fail (-1), never return stale cached bytes.
                {op: 'source_read', sourceIndex: 0, offset: 5, len: 6},
                {op: 'source_read', sourceIndex: 0, offset: 0, len: 5},
                {op: 'source_len', sourceIndex: 0},
            ];
            const results = decodeProbeOutput(script, runner.runFileRequest(encodeProbeScript(script), io));
            expect(new TextDecoder().decode(results[0]!.bytes)).toBe('OLD-CONTENT');
            expect(results[1]!.status).toBe(0);
            expect(results[2]!.status).toBe(-1);
            expect(results[3]!.status).toBe(0);
            expect(new TextDecoder().decode(results[3]!.bytes)).toBe('SHORT');
            expect(results[4]!.length).toBe(5);
            if (io.sink?.fd !== null && io.sink?.fd !== undefined) {
                closeSync(io.sink.fd);
            }
        } finally {
            closeSync(srcFd);
            runner.dispose();
        }
    });

    it('ensures post-write readback validation (evb_host_sink_read) always reads real OS bytes', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-read-cache-readback-'));
        const sourcePath = join(tempDir, 'source-other-inode.bin');
        const sinkPath = join(tempDir, 'sink-real-inode.bin');
        writeFileSync(sourcePath, Buffer.from('SOURCE-CONFLICT-BYTES-0123456789', 'ascii'));
        writeFileSync(sinkPath, Buffer.from('SINK-ORIGINAL-BYTES-9876543210!!', 'ascii'));

        const runner = createPdfPageOpsWasmRunner(probeModule, {readCacheBlockBytes: 64, readCacheMaxBlocks: 4});
        const srcFd = openSync(sourcePath, 'r');
        const sinkFd = openSync(sinkPath, 'r+');
        try {
            const io: IHostIoContext = {
                sources: [{fd: srcFd, len: 32, path: sourcePath}],
                extraOpenOrder: [],
                sink: {
                    fd: sinkFd,
                    path: sinkPath,
                    inPlace: true,
                    originalLen: 32,
                    baseSourceLen: 0,
                    baseCopied: true,
                    writtenAny: false,
                    maxLen: 32,
                },
                memory: null,
            };
            const revision = new TextEncoder().encode('\n%INCREMENTAL-REVISION\n%%EOF\n');
            const script: TProbeInstruction[] = [
                // Warm source block 0 with conflicting bytes at offset 0 (no write invalidation!).
                {op: 'source_read', sourceIndex: 0, offset: 0, len: 32},
                // Reading offset 0 from sink must return sink's own OS bytes, never source's cache.
                {op: 'sink_read', offset: 0, len: 32},
                // Append to sink and read back via evb_host_sink_read.
                {op: 'sink_write', at: 32, bytes: revision},
                {op: 'sink_read', offset: 32, len: revision.byteLength},
            ];
            const results = decodeProbeOutput(script, runner.runFileRequest(encodeProbeScript(script), io));
            expect(new TextDecoder().decode(results[0]!.bytes)).toBe('SOURCE-CONFLICT-BYTES-0123456789');
            expect(results[1]!.status).toBe(0);
            expect(new TextDecoder().decode(results[1]!.bytes)).toBe('SINK-ORIGINAL-BYTES-9876543210!!');
            expect(results[2]!.status).toBe(0);
            expect(results[3]!.status).toBe(0);
            expect(results[3]!.bytes).toEqual(revision);
            expect(readFileSync(sinkPath).subarray(32)).toEqual(Buffer.from(revision));
        } finally {
            closeSync(srcFd);
            closeSync(sinkFd);
            runner.dispose();
        }
    });

    it('invalidates cached blocks on extra-source FD eviction within the same command', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-read-cache-fd-evict-'));
        const sources: IHostIoContext['sources'] = [];
        for (let i = 0; i <= 18; i += 1) {
            const p = join(tempDir, `src-${i}.bin`);
            writeFileSync(p, Buffer.from(`SRC-${String(i).padStart(2, '0')}-INITIAL`, 'ascii'));
            sources.push({fd: i === 0 ? openSync(p, 'r') : null, len: null, path: p});
        }
        // Sink aliases source 1 so mutating sink after source 1 is evicted must still leave
        // source 1 reading fresh bytes when source 1 is reopened later in the same command.
        const sinkFd = openSync(sources[1]!.path, 'r+');
        const runner = createPdfPageOpsWasmRunner(probeModule, {readCacheBlockBytes: 64, readCacheMaxBlocks: 32});
        const io: IHostIoContext = {
            sources,
            extraOpenOrder: [],
            sink: {
                fd: sinkFd,
                path: sources[1]!.path,
                inPlace: true,
                originalLen: 14,
                baseSourceLen: 0,
                baseCopied: true,
                writtenAny: false,
                maxLen: 14,
            },
            memory: null,
        };
        try {
            // Read source 1 (opens fd, caches block), then read sources 2..18 (evicts source 1 fd
            // and invalidates source 1 cache), mutate source 1 via sink_write, then re-read source 1.
            const script: TProbeInstruction[] = [{op: 'source_read', sourceIndex: 1, offset: 0, len: 14}];
            for (let i = 2; i <= 18; i += 1) {
                script.push({op: 'source_read', sourceIndex: i, offset: 0, len: 14});
            }
            const updated = new TextEncoder().encode('SRC-01-UPDATED');
            script.push({op: 'sink_write', at: 0, bytes: updated});
            script.push({op: 'source_len', sourceIndex: 1});
            script.push({op: 'source_read', sourceIndex: 1, offset: 0, len: 14});

            const results = decodeProbeOutput(script, runner.runFileRequest(encodeProbeScript(script), io));
            expect(new TextDecoder().decode(results[0]!.bytes)).toBe('SRC-01-INITIAL');
            expect(results.at(-2)!.length).toBe(14);
            expect(new TextDecoder().decode(results.at(-1)!.bytes)).toBe('SRC-01-UPDATED');
        } finally {
            closeSync(sinkFd);
            for (const entry of io.sources) {
                if (entry.fd !== null) {
                    closeSync(entry.fd);
                }
            }
            runner.dispose();
        }
    });

    it('invalidates aliased source blocks even when evb_host_source_copy fails after writing one chunk', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-read-cache-partial-copy-'));
        const chunkBytes = 4 * 1024 * 1024;
        const targetPath = join(tempDir, 'target.bin');
        const donorPath = join(tempDir, 'donor.bin');
        writeFileSync(targetPath, Buffer.alloc(chunkBytes + 16, 0x41)); // 'A'
        writeFileSync(donorPath, Buffer.alloc(chunkBytes + 16, 0x5a)); // 'Z'

        const runner = createPdfPageOpsWasmRunner(probeModule, {readCacheBlockBytes: 64, readCacheMaxBlocks: 8});
        const targetFd = openSync(targetPath, 'r');
        const sinkFd = openSync(targetPath, 'r+');
        const io: IHostIoContext = {
            sources: [
                {fd: targetFd, len: chunkBytes + 16, path: targetPath},
                {fd: null, len: null, path: donorPath},
            ],
            extraOpenOrder: [],
            sink: {
                fd: sinkFd,
                path: targetPath,
                inPlace: true,
                originalLen: chunkBytes + 16,
                baseSourceLen: 0,
                baseCopied: true,
                writtenAny: false,
                maxLen: chunkBytes + 16,
            },
            memory: null,
        };
        try {
            const script: TProbeInstruction[] = [
                {op: 'source_read', sourceIndex: 0, offset: 0, len: 16},
                // Request more bytes than donor has so chunk 1 (4 MiB of 'Z') writes to aliased sink
                // and chunk 2 fails EOF (-1).
                {op: 'source_copy', sourceIndex: 1, offset: 0, len: chunkBytes + 64, at: 0},
                // Must read the partially written 'Z' bytes from OS, never stale cached 'A's.
                {op: 'source_read', sourceIndex: 0, offset: 0, len: 16},
            ];
            const results = decodeProbeOutput(script, runner.runFileRequest(encodeProbeScript(script), io));
            expect(new TextDecoder().decode(results[0]!.bytes)).toBe('A'.repeat(16));
            expect(results[1]!.status).toBe(-1);
            expect(results[2]!.status).toBe(0);
            expect(new TextDecoder().decode(results[2]!.bytes)).toBe('Z'.repeat(16));
        } finally {
            closeSync(targetFd);
            closeSync(sinkFd);
            if (io.sources[1]?.fd !== null && io.sources[1]?.fd !== undefined) {
                closeSync(io.sources[1].fd);
            }
            runner.dispose();
        }
    });

    it('rejects a lazy non-in-place append whose staging path aliases source 0 without truncating or staling cache', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-read-cache-lazy-alias-'));
        const sourcePath = join(tempDir, 'source.bin');
        const hardlinkSinkPath = join(tempDir, 'hardlink-sink.bin');
        writeFileSync(sourcePath, Buffer.from('PRESERVE-ORIGINAL-SOURCE', 'ascii'));
        linkSync(sourcePath, hardlinkSinkPath);

        const runner = createPdfPageOpsWasmRunner(probeModule, {readCacheBlockBytes: 64, readCacheMaxBlocks: 4});
        const srcFd = openSync(sourcePath, 'r');
        const io: IHostIoContext = {
            sources: [{fd: srcFd, len: 24, path: sourcePath}],
            extraOpenOrder: [],
            sink: {
                fd: null,
                path: hardlinkSinkPath,
                inPlace: false,
                originalLen: 0,
                baseSourceLen: 24,
                baseCopied: false,
                writtenAny: false,
                maxLen: 0,
            },
            memory: null,
        };
        try {
            const script: TProbeInstruction[] = [
                {op: 'source_read', sourceIndex: 0, offset: 0, len: 24},
                {op: 'sink_write', at: 24, bytes: new TextEncoder().encode('APPEND')},
                {op: 'source_len', sourceIndex: 0},
                {op: 'source_read', sourceIndex: 0, offset: 0, len: 24},
            ];
            const results = decodeProbeOutput(script, runner.runFileRequest(encodeProbeScript(script), io));
            expect(new TextDecoder().decode(results[0]!.bytes)).toBe('PRESERVE-ORIGINAL-SOURCE');
            expect(results[1]!.status).toBe(-1);
            expect(results[2]!.length).toBe(24);
            expect(new TextDecoder().decode(results[3]!.bytes)).toBe('PRESERVE-ORIGINAL-SOURCE');
            expect(readFileSync(sourcePath, 'ascii')).toBe('PRESERVE-ORIGINAL-SOURCE');
        } finally {
            closeSync(srcFd);
            if (io.sink?.fd !== null && io.sink?.fd !== undefined) {
                closeSync(io.sink.fd);
            }
            runner.dispose();
        }
    });
});
