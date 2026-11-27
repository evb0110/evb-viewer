/**
 * Replaces every `memory.copy` and `memory.fill` in a WebAssembly module with
 * a call to an equivalent function made of plain loads and stores.
 *
 * A threaded engine's instances share one memory, and V8 checks the bulk
 * memory instructions against each instance's own record of its size, which
 * hears of another thread's growth only at that instance's next interrupt
 * check. A bulk instruction on memory another thread just grew can then trap
 * although the memory is there. Plain loads and stores are checked by the
 * memory's committed pages, which every thread sees at once on 64-bit
 * engines, so lowered copies and fills cannot hit that race.
 *
 * The functions this adds copy and fill eight bytes at a time with unaligned
 * 64-bit loads and stores and keep `memory.copy`'s overlap semantics. A range
 * that would end past 2^32 traps before anything is written. Two differences
 * from the instructions remain, both only for out-of-bounds ranges, which a
 * correct program never issues: a zero-length range past the memory's end
 * does not trap, and a range that runs off the end writes up to the end before
 * it traps. Matching the instructions there would need the memory's size, and
 * reading it (`memory.size`) brings back the stale size this step exists to
 * avoid. Either way the thread traps or a correct program's result is the
 * same. `memory.init`, which initializes the shared memory's passive segments
 * once, is left as it is.
 *
 * The decoder reads WebAssembly 2.0 with SIMD128 (`0xfd`), threads, and
 * multiple memories, and throws on anything else rather than guess, so a
 * module it cannot read is never half rewritten: exception handling,
 * memory64, GC types, and a `memory.copy` or `memory.fill` on any memory but
 * the first.
 */

const SECTION_TYPE = 1;
const SECTION_IMPORT = 2;
const SECTION_FUNCTION = 3;
const SECTION_CODE = 10;

/** Value types encoded in one byte: numbers, v128, funcref, externref. */
const VALUE_TYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f]);
const REFERENCE_TYPES = new Set([0x70, 0x6f]);
/** A memarg alignment with this bit set carries a memory index. */
const MEMARG_HAS_MEMORY = 0x40;

/** @param {Uint8Array} bytes @param {number} offset @returns {number} */
function byteAt(bytes, offset) {
    const byte = bytes[offset];
    if (byte === undefined) {throw new Error('Truncated WebAssembly module');}
    return byte;
}

/** @param {Uint8Array} bytes @param {number} offset */
function readU32(bytes, offset) {
    let value = 0;
    let shift = 0;
    let byte;
    do {
        if (shift > 28) {throw new Error(`Overlong WebAssembly u32 at byte ${offset}`);}
        byte = byteAt(bytes, offset++);
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
    } while (byte & 0x80);
    return {value, offset};
}

/** Skips a signed or unsigned LEB128 value. @param {Uint8Array} bytes @param {number} offset */
function skipLeb(bytes, offset) {
    const start = offset;
    while (byteAt(bytes, offset++) & 0x80) {
        if (offset - start >= 10) {throw new Error(`Overlong WebAssembly LEB128 at byte ${start}`);}
    }
    return offset;
}

/** @param {number} value @returns {number[]} */
function encodeU32(value) {
    let remaining = value;
    const out = [];
    do {
        let byte = remaining & 0x7f;
        remaining = Math.floor(remaining / 128);
        if (remaining !== 0) {byte |= 0x80;}
        out.push(byte);
    } while (remaining !== 0);
    return out;
}

/** @param {bigint} value @returns {number[]} */
function encodeS64(value) {
    const out = [];
    let remaining = BigInt.asIntN(64, value);
    for (;;) {
        const byte = Number(remaining & 0x7fn);
        remaining >>= 7n;
        const done = (remaining === 0n && !(byte & 0x40)) || (remaining === -1n && (byte & 0x40));
        out.push(done ? byte : byte | 0x80);
        if (done) {return out;}
    }
}

/** @param {Uint8Array[]} parts @returns {Uint8Array<ArrayBuffer>} */
function concat(parts) {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

/** @param {Uint8Array} bytes @param {number} offset @param {string} what */
function readValueType(bytes, offset, what) {
    const type = byteAt(bytes, offset);
    if (!VALUE_TYPES.has(type)) {
        throw new Error(`Unsupported WebAssembly ${what} type 0x${type.toString(16)} at byte ${offset}`);
    }
    return offset + 1;
}

/** Skips a block type: empty, one value type, or a type index. @param {Uint8Array} bytes @param {number} offset */
function skipBlockType(bytes, offset) {
    const byte = byteAt(bytes, offset);
    if (byte === 0x40 || VALUE_TYPES.has(byte)) {return offset + 1;}
    // A one-byte s33 from 0x40 to 0x7f is negative: a type code, not an index.
    if (byte >= 0x40 && byte <= 0x7f) {
        throw new Error(`Unsupported WebAssembly block type 0x${byte.toString(16)} at byte ${offset}`);
    }
    return skipLeb(bytes, offset);
}

/** @param {Uint8Array} bytes @param {number} offset */
function skipMemarg(bytes, offset) {
    const align = readU32(bytes, offset);
    offset = align.offset;
    if (align.value & MEMARG_HAS_MEMORY) {offset = skipLeb(bytes, offset);}
    return skipLeb(bytes, offset);
}

/** Reads a memory index that must be the first memory. @param {Uint8Array} bytes @param {number} offset @param {number} start */
function readFirstMemory(bytes, offset, start) {
    const memory = readU32(bytes, offset);
    if (memory.value !== 0) {
        throw new Error(`A bulk memory instruction at byte ${start} targets memory ${memory.value}; only memory 0 can be lowered`);
    }
    return memory.offset;
}

/**
 * Walks one function body's instructions and calls `visit` with each
 * `memory.copy` or `memory.fill`: its kind, start and end offsets.
 * @param {Uint8Array} bytes
 * @param {number} offset first instruction
 * @param {number} end end of the body
 * @param {(kind: 'copy' | 'fill', start: number, end: number) => void} visit
 */
function walkInstructions(bytes, offset, end, visit) {
    while (offset < end) {
        const start = offset;
        const opcode = byteAt(bytes, offset++);
        if (opcode <= 0x01 || opcode === 0x05 || opcode === 0x0b || opcode === 0x0f
            || opcode === 0x1a || opcode === 0x1b || opcode === 0xd1
            || (opcode >= 0x45 && opcode <= 0xc4)) {
            continue;
        }
        if (opcode >= 0x02 && opcode <= 0x04) {
            offset = skipBlockType(bytes, offset);
        } else if (opcode === 0x0c || opcode === 0x0d || opcode === 0x10 || opcode === 0x12
            || opcode === 0xd2 || (opcode >= 0x20 && opcode <= 0x26)) {
            offset = skipLeb(bytes, offset);
        } else if (opcode === 0x0e) {
            const targets = readU32(bytes, offset);
            offset = targets.offset;
            for (let index = 0; index <= targets.value; index += 1) {offset = skipLeb(bytes, offset);}
        } else if (opcode === 0x11 || opcode === 0x13) {
            offset = skipLeb(bytes, skipLeb(bytes, offset));
        } else if (opcode === 0x1c) {
            const types = readU32(bytes, offset);
            offset = types.offset;
            for (let index = 0; index < types.value; index += 1) {offset = readValueType(bytes, offset, 'select');}
        } else if (opcode >= 0x28 && opcode <= 0x3e) {
            offset = skipMemarg(bytes, offset);
        } else if (opcode === 0x3f || opcode === 0x40 || opcode === 0x41 || opcode === 0x42) {
            offset = skipLeb(bytes, offset);
        } else if (opcode === 0x43) {
            offset += 4;
        } else if (opcode === 0x44) {
            offset += 8;
        } else if (opcode === 0xd0) {
            const heapType = byteAt(bytes, offset);
            if (!REFERENCE_TYPES.has(heapType)) {
                throw new Error(`Unsupported WebAssembly ref.null type 0x${heapType.toString(16)} at byte ${start}`);
            }
            offset += 1;
        } else if (opcode === 0xfc) {
            const sub = readU32(bytes, offset);
            offset = sub.offset;
            switch (sub.value) {
                case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
                    break;
                case 8: case 12: case 14:
                    offset = skipLeb(bytes, skipLeb(bytes, offset));
                    break;
                case 9: case 13: case 15: case 16: case 17:
                    offset = skipLeb(bytes, offset);
                    break;
                case 10:
                    offset = readFirstMemory(bytes, readFirstMemory(bytes, offset, start), start);
                    visit('copy', start, offset);
                    break;
                case 11:
                    offset = readFirstMemory(bytes, offset, start);
                    visit('fill', start, offset);
                    break;
                default:
                    throw new Error(`Unknown WebAssembly 0xfc instruction ${sub.value} at byte ${start}`);
            }
        } else if (opcode === 0xfd) {
            const sub = readU32(bytes, offset);
            offset = sub.offset;
            if (sub.value <= 0x0b || sub.value === 0x5c || sub.value === 0x5d) {
                offset = skipMemarg(bytes, offset);
            } else if (sub.value === 0x0c || sub.value === 0x0d) {
                if (offset + 16 > end) {throw new Error(`Truncated WebAssembly SIMD128 immediate at byte ${start}`);}
                offset += 16;
            } else if (sub.value >= 0x15 && sub.value <= 0x22) {
                if (offset + 1 > end) {throw new Error(`Truncated WebAssembly SIMD128 lane index at byte ${start}`);}
                offset += 1;
            } else if (sub.value >= 0x54 && sub.value <= 0x5b) {
                offset = skipMemarg(bytes, offset);
                if (offset + 1 > end) {throw new Error(`Truncated WebAssembly SIMD128 lane index at byte ${start}`);}
                offset += 1;
            } else if (sub.value <= 0xff) {
                // Remaining WebAssembly 2.0 fixed-width SIMD128 instructions take no immediates.
            } else {
                throw new Error(`Unknown WebAssembly 0xfd instruction ${sub.value} at byte ${start}`);
            }
        } else if (opcode === 0xfe) {
            const sub = readU32(bytes, offset);
            offset = sub.offset;
            if (sub.value === 0x03) {
                if (byteAt(bytes, offset) !== 0) {throw new Error(`Unknown atomic.fence encoding at byte ${start}`);}
                offset += 1;
            } else if (sub.value <= 0x02 || (sub.value >= 0x10 && sub.value <= 0x4e)) {
                offset = skipMemarg(bytes, offset);
            } else {
                throw new Error(`Unknown WebAssembly atomic instruction ${sub.value} at byte ${start}`);
            }
        } else {
            throw new Error(`Unknown WebAssembly instruction 0x${opcode.toString(16)} at byte ${start}`);
        }
    }
    if (offset !== end) {throw new Error('A WebAssembly function body ends inside an instruction');}
}

/** @param {Uint8Array} bytes */
function readSections(bytes) {
    if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d
        || bytes[4] !== 0x01 || bytes[5] !== 0x00 || bytes[6] !== 0x00 || bytes[7] !== 0x00) {
        throw new Error('Not a WebAssembly 1.0 binary module');
    }
    const sections = [];
    let offset = 8;
    while (offset < bytes.length) {
        const id = byteAt(bytes, offset);
        const size = readU32(bytes, offset + 1);
        const end = size.offset + size.value;
        if (end > bytes.length) {throw new Error('Truncated WebAssembly section');}
        sections.push({id, start: offset, contentStart: size.offset, end});
        offset = end;
    }
    return sections;
}

/**
 * Each function body in the code section: content start and end.
 * @param {Uint8Array} bytes
 * @param {{contentStart: number}} section
 */
function readBodies(bytes, section) {
    const count = readU32(bytes, section.contentStart);
    let offset = count.offset;
    const bodies = [];
    for (let index = 0; index < count.value; index += 1) {
        const size = readU32(bytes, offset);
        bodies.push({start: size.offset, end: size.offset + size.value});
        offset = size.offset + size.value;
    }
    return bodies;
}

/**
 * The offset of a body's first instruction, past its local declarations.
 * @param {Uint8Array} bytes
 * @param {{start: number}} body
 */
function firstInstruction(bytes, body) {
    const groups = readU32(bytes, body.start);
    let offset = groups.offset;
    for (let index = 0; index < groups.value; index += 1) {
        offset = readValueType(bytes, skipLeb(bytes, offset), 'local');
    }
    return offset;
}

/** Skips table or memory limits. @param {Uint8Array} bytes @param {number} offset @param {number[]} allowedFlags @param {string} what */
function skipLimits(bytes, offset, allowedFlags, what) {
    const flags = readU32(bytes, offset);
    if (!allowedFlags.includes(flags.value)) {
        throw new Error(`Unsupported WebAssembly ${what} limits flags ${flags.value}`);
    }
    offset = skipLeb(bytes, flags.offset);
    return flags.value & 1 ? skipLeb(bytes, offset) : offset;
}

/** The number of imported functions. @param {Uint8Array} bytes @param {{contentStart: number} | undefined} section */
function countImportedFunctions(bytes, section) {
    if (!section) {return 0;}
    let functions = 0;
    const count = readU32(bytes, section.contentStart);
    let offset = count.offset;
    for (let index = 0; index < count.value; index += 1) {
        const moduleName = readU32(bytes, offset);
        const fieldName = readU32(bytes, moduleName.offset + moduleName.value);
        offset = fieldName.offset + fieldName.value;
        const kind = byteAt(bytes, offset++);
        if (kind === 0x00) {
            functions += 1;
            offset = skipLeb(bytes, offset);
        } else if (kind === 0x01) {
            const type = byteAt(bytes, offset);
            if (!REFERENCE_TYPES.has(type)) {throw new Error(`Unsupported WebAssembly table type 0x${type.toString(16)}`);}
            offset = skipLimits(bytes, offset + 1, [0, 1], 'table');
        } else if (kind === 0x02) {
            // Unshared or shared 32-bit memories; not memory64 or custom page sizes.
            offset = skipLimits(bytes, offset, [0, 1, 2, 3], 'memory');
        } else if (kind === 0x03) {
            offset = readValueType(bytes, offset, 'global');
            const mutability = byteAt(bytes, offset++);
            if (mutability > 1) {throw new Error(`Unsupported WebAssembly global mutability ${mutability}`);}
        } else {
            throw new Error(`Unsupported WebAssembly import kind ${kind}`);
        }
    }
    return functions;
}

/**
 * The `memory.copy` and `memory.fill` instructions a module contains.
 * @param {Uint8Array} bytes
 * @returns {{copy: number, fill: number}}
 */
export function countWasmBulkMemory(bytes) {
    const counts = {copy: 0, fill: 0};
    const code = readSections(bytes).find(section => section.id === SECTION_CODE);
    if (!code) {return counts;}
    for (const body of readBodies(bytes, code)) {
        walkInstructions(bytes, firstInstruction(bytes, body), body.end, (kind) => {
            counts[kind] += 1;
        });
    }
    return counts;
}

const I32 = 0x7f;
const I64 = 0x7e;
const op = {
    unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, brIf: 0x0d,
    localGet: 0x20, localSet: 0x21,
    i64Load: 0x29, i32Load8U: 0x2d, i64Store: 0x37, i32Store8: 0x3a,
    i32Const: 0x41, i64Const: 0x42, i32Eqz: 0x45, i32LtU: 0x49, i32GeU: 0x4f, i64GtU: 0x56,
    i32Add: 0x6a, i32Sub: 0x6b, i32And: 0x71, i64Add: 0x7c, i64Mul: 0x7e, i64ExtendI32U: 0xad,
};
const VOID = 0x40;
/** Alignment hint 1 byte, offset 0: unaligned accesses are valid and fast. */
const UNALIGNED = [0x00, 0x00];

/** `local = local + delta` @param {number} local @param {number} delta */
function step(local, delta) {
    return [op.localGet, local, op.i32Const, ...encodeS64(BigInt(delta)), op.i32Add, op.localSet, local];
}

/**
 * Traps when `local + length` passes 2^32, computed in 64 bits so it cannot
 * wrap. An end of exactly 2^32 is the last byte of a full memory.
 * @param {number} local
 */
function trapPast4GiB(local) {
    return [
        op.localGet, local, op.i64ExtendI32U, op.localGet, 2, op.i64ExtendI32U, op.i64Add,
        op.i64Const, ...encodeS64(2n ** 32n), op.i64GtU,
        op.if, VOID, op.unreachable, op.end,
    ];
}

/**
 * (dst, src, n): forward when `dst - src >= n` unsigned, which is every case
 * a forward copy cannot overwrite unread source in, backward otherwise.
 */
const COPY_BODY = [
    0, // no locals besides the parameters
    ...trapPast4GiB(0), ...trapPast4GiB(1),
    op.localGet, 0, op.localGet, 1, op.i32Sub, op.localGet, 2, op.i32GeU,
    op.if, VOID,
    op.block, VOID,
    op.block, VOID,
    op.loop, VOID,
    op.localGet, 2, op.i32Const, 8, op.i32LtU, op.brIf, 1,
    op.localGet, 0, op.localGet, 1, op.i64Load, ...UNALIGNED, op.i64Store, ...UNALIGNED,
    ...step(0, 8), ...step(1, 8), ...step(2, -8),
    op.br, 0,
    op.end,
    op.end,
    op.loop, VOID,
    op.localGet, 2, op.i32Eqz, op.brIf, 1,
    op.localGet, 0, op.localGet, 1, op.i32Load8U, ...UNALIGNED, op.i32Store8, ...UNALIGNED,
    ...step(0, 1), ...step(1, 1), ...step(2, -1),
    op.br, 0,
    op.end,
    op.end,
    op.else,
    op.block, VOID,
    op.block, VOID,
    op.loop, VOID,
    op.localGet, 2, op.i32Const, 8, op.i32LtU, op.brIf, 1,
    ...step(2, -8),
    op.localGet, 0, op.localGet, 2, op.i32Add,
    op.localGet, 1, op.localGet, 2, op.i32Add, op.i64Load, ...UNALIGNED,
    op.i64Store, ...UNALIGNED,
    op.br, 0,
    op.end,
    op.end,
    op.loop, VOID,
    op.localGet, 2, op.i32Eqz, op.brIf, 1,
    ...step(2, -1),
    op.localGet, 0, op.localGet, 2, op.i32Add,
    op.localGet, 1, op.localGet, 2, op.i32Add, op.i32Load8U, ...UNALIGNED,
    op.i32Store8, ...UNALIGNED,
    op.br, 0,
    op.end,
    op.end,
    op.end,
    op.end,
];

/** (dst, value, n), with local 3 the value's low byte repeated eight times. */
const FILL_BODY = [
    1, 1, I64,
    ...trapPast4GiB(0),
    op.localGet, 1, op.i32Const, ...encodeS64(255n), op.i32And, op.i64ExtendI32U,
    op.i64Const, ...encodeS64(0x0101010101010101n), op.i64Mul, op.localSet, 3,
    op.block, VOID,
    op.block, VOID,
    op.loop, VOID,
    op.localGet, 2, op.i32Const, 8, op.i32LtU, op.brIf, 1,
    op.localGet, 0, op.localGet, 3, op.i64Store, ...UNALIGNED,
    ...step(0, 8), ...step(2, -8),
    op.br, 0,
    op.end,
    op.end,
    op.loop, VOID,
    op.localGet, 2, op.i32Eqz, op.brIf, 1,
    op.localGet, 0, op.localGet, 1, op.i32Store8, ...UNALIGNED,
    ...step(0, 1), ...step(2, -1),
    op.br, 0,
    op.end,
    op.end,
    op.end,
];

/** @param {number} id @param {Uint8Array[]} content */
function section(id, content) {
    const body = concat(content);
    return concat([Uint8Array.of(id, ...encodeU32(body.byteLength)), body]);
}

/**
 * The module with each `memory.copy` and `memory.fill` replaced by a call.
 * @param {Uint8Array} bytes
 * @returns {{bytes: Uint8Array<ArrayBuffer>, lowered: {copy: number, fill: number}}}
 */
export function lowerWasmBulkMemory(bytes) {
    const sections = readSections(bytes);
    /** @param {number} id */
    const byId = id => sections.find(entry => entry.id === id);
    const typeSection = byId(SECTION_TYPE);
    const functionSection = byId(SECTION_FUNCTION);
    const codeSection = byId(SECTION_CODE);
    if (!typeSection || !functionSection || !codeSection) {
        throw new Error('The module has no functions to lower');
    }

    const importedFunctions = countImportedFunctions(bytes, byId(SECTION_IMPORT));
    const types = readU32(bytes, typeSection.contentStart);
    const definedFunctions = readU32(bytes, functionSection.contentStart);
    const copyFunction = importedFunctions + definedFunctions.value;
    const fillFunction = copyFunction + 1;
    const calls = {
        copy: Uint8Array.of(0x10, ...encodeU32(copyFunction)),
        fill: Uint8Array.of(0x10, ...encodeU32(fillFunction)),
    };

    const lowered = {copy: 0, fill: 0};
    /** @type {Uint8Array[]} */
    const codeParts = [Uint8Array.from(encodeU32(definedFunctions.value + 2))];
    for (const body of readBodies(bytes, codeSection)) {
        /** @type {Uint8Array[]} */
        const parts = [];
        let copied = body.start;
        walkInstructions(bytes, firstInstruction(bytes, body), body.end, (kind, start, end) => {
            parts.push(bytes.subarray(copied, start), calls[kind]);
            copied = end;
            lowered[kind] += 1;
        });
        parts.push(bytes.subarray(copied, body.end));
        const content = concat(parts);
        codeParts.push(Uint8Array.from(encodeU32(content.byteLength)), content);
    }
    for (const body of [COPY_BODY, FILL_BODY]) {
        codeParts.push(Uint8Array.from(encodeU32(body.length)), Uint8Array.from(body));
    }

    const newType = types.value;
    const replaced = new Map([
        [typeSection, section(SECTION_TYPE, [
            Uint8Array.from(encodeU32(types.value + 1)),
            bytes.subarray(types.offset, typeSection.end),
            Uint8Array.of(0x60, 3, I32, I32, I32, 0),
        ])],
        [functionSection, section(SECTION_FUNCTION, [
            Uint8Array.from(encodeU32(definedFunctions.value + 2)),
            bytes.subarray(definedFunctions.offset, functionSection.end),
            Uint8Array.of(...encodeU32(newType), ...encodeU32(newType)),
        ])],
        [codeSection, section(SECTION_CODE, codeParts)],
    ]);
    const output = concat([
        bytes.subarray(0, 8),
        ...sections.map(entry => replaced.get(entry) ?? bytes.subarray(entry.start, entry.end)),
    ]);
    return {bytes: output, lowered};
}
