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
 * 64-bit loads and stores, keep `memory.copy`'s overlap semantics, and check
 * no bounds themselves: an access past the memory traps as it reaches it.
 * `memory.init`, which initializes the shared memory's passive segments once,
 * is left as it is.
 */

const SECTION_TYPE = 1;
const SECTION_IMPORT = 2;
const SECTION_FUNCTION = 3;
const SECTION_CODE = 10;
const IMPORT_FUNCTION = 0;

/** @param {Uint8Array} bytes @param {number} offset @returns {number} */
function byteAt(bytes, offset) {
    const byte = bytes[offset];
    if (byte === undefined) throw new Error('Truncated WebAssembly module');
    return byte;
}

/** @param {Uint8Array} bytes @param {number} offset */
function readU32(bytes, offset) {
    let value = 0;
    let shift = 0;
    let byte;
    do {
        byte = byteAt(bytes, offset++);
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
    } while (byte & 0x80);
    return {value, offset};
}

/** Skips a signed or unsigned LEB128 value. @param {Uint8Array} bytes @param {number} offset */
function skipLeb(bytes, offset) {
    while (byteAt(bytes, offset++) & 0x80) {
        // continuation byte
    }
    return offset;
}

/** @param {number | bigint} value @returns {number[]} */
function encodeU32(value) {
    let remaining = Number(value);
    const out = [];
    do {
        let byte = remaining & 0x7f;
        remaining = Math.floor(remaining / 128);
        if (remaining !== 0) byte |= 0x80;
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
        if (done) return out;
    }
}

/** @param {number} count @param {number[]} content */
function vector(count, content) {
    return [...encodeU32(count), ...content];
}

/** Skips a block type: empty, one value type, or a type index. @param {Uint8Array} bytes @param {number} offset */
function skipBlockType(bytes, offset) {
    const byte = byteAt(bytes, offset);
    if (byte === 0x40 || (byte >= 0x6f && byte <= 0x7f)) return offset + 1;
    return skipLeb(bytes, offset);
}

/** @param {Uint8Array} bytes @param {number} offset */
function skipMemarg(bytes, offset) {
    return skipLeb(bytes, skipLeb(bytes, offset));
}

/**
 * Walks one function body's instructions and calls `visit` with each
 * `memory.copy` or `memory.fill`: its kind, start and end offsets.
 * Throws on an instruction it does not know, so a module it cannot read is
 * never half rewritten.
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
            for (let index = 0; index <= targets.value; index += 1) offset = skipLeb(bytes, offset);
        } else if (opcode === 0x11 || opcode === 0x13) {
            offset = skipLeb(bytes, skipLeb(bytes, offset));
        } else if (opcode === 0x1c) {
            const types = readU32(bytes, offset);
            offset = types.offset + types.value;
        } else if (opcode >= 0x28 && opcode <= 0x3e) {
            offset = skipMemarg(bytes, offset);
        } else if (opcode === 0x3f || opcode === 0x40 || opcode === 0x41 || opcode === 0x42) {
            offset = skipLeb(bytes, offset);
        } else if (opcode === 0x43) {
            offset += 4;
        } else if (opcode === 0x44) {
            offset += 8;
        } else if (opcode === 0xd0) {
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
                    offset = skipLeb(bytes, skipLeb(bytes, offset));
                    visit('copy', start, offset);
                    break;
                case 11:
                    offset = skipLeb(bytes, offset);
                    visit('fill', start, offset);
                    break;
                default:
                    throw new Error(`Unknown WebAssembly 0xfc instruction ${sub.value} at byte ${start}`);
            }
        } else if (opcode === 0xfe) {
            const sub = readU32(bytes, offset);
            offset = sub.offset;
            if (sub.value === 0x03) {
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
    if (offset !== end) throw new Error('A WebAssembly function body ends inside an instruction');
}

/** @param {Uint8Array} bytes */
function readSections(bytes) {
    if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
        throw new Error('Not a WebAssembly module');
    }
    const sections = [];
    let offset = 8;
    while (offset < bytes.length) {
        const id = bytes[offset];
        const size = readU32(bytes, offset + 1);
        sections.push({id, start: offset, contentStart: size.offset, end: size.offset + size.value});
        offset = size.offset + size.value;
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
        offset = skipLeb(bytes, offset) + 1;
    }
    return offset;
}

/**
 * The `memory.copy` and `memory.fill` instructions a module contains.
 * @param {Uint8Array} bytes
 * @returns {{copy: number, fill: number}}
 */
export function countWasmBulkMemory(bytes) {
    const counts = {copy: 0, fill: 0};
    const code = readSections(bytes).find(section => section.id === SECTION_CODE);
    if (!code) return counts;
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
    block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, brIf: 0x0d,
    localGet: 0x20, localSet: 0x21,
    i64Load: 0x29, i32Load8U: 0x2d, i64Store: 0x37, i32Store8: 0x3a,
    i32Const: 0x41, i64Const: 0x42, i32Eqz: 0x45, i32LtU: 0x49, i32GeU: 0x4f,
    i32Add: 0x6a, i32Sub: 0x6b, i32And: 0x71, i64Mul: 0x7e, i64ExtendI32U: 0xad,
};
const VOID = 0x40;
/** Alignment hint 1 byte, offset 0: unaligned accesses are valid and fast. */
const UNALIGNED = [0x00, 0x00];

/** `local = local + delta` @param {number} local @param {number} delta */
function step(local, delta) {
    return [op.localGet, local, op.i32Const, ...encodeS64(BigInt(delta)), op.i32Add, op.localSet, local];
}

/**
 * (dst, src, n): forward when `dst - src >= n` unsigned, which is every case
 * a forward copy cannot overwrite unread source in, backward otherwise.
 */
const COPY_BODY = [
    0, // no locals besides the parameters
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

/** @param {number} id @param {number[]} content */
function section(id, content) {
    return [id, ...encodeU32(content.length), ...content];
}

/**
 * The module with each `memory.copy` and `memory.fill` replaced by a call.
 * @param {Uint8Array} bytes
 * @returns {{bytes: Uint8Array, lowered: {copy: number, fill: number}}}
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

    let importedFunctions = 0;
    const importSection = byId(SECTION_IMPORT);
    if (importSection) {
        const count = readU32(bytes, importSection.contentStart);
        let offset = count.offset;
        for (let index = 0; index < count.value; index += 1) {
            const moduleName = readU32(bytes, offset);
            const fieldName = readU32(bytes, moduleName.offset + moduleName.value);
            offset = fieldName.offset + fieldName.value;
            const kind = byteAt(bytes, offset++);
            if (kind === IMPORT_FUNCTION) {
                importedFunctions += 1;
                offset = skipLeb(bytes, offset);
            } else if (kind === 0x01) {
                offset += 1;
                const flags = readU32(bytes, offset);
                offset = skipLeb(bytes, flags.offset);
                if (flags.value & 1) offset = skipLeb(bytes, offset);
            } else if (kind === 0x02) {
                const flags = readU32(bytes, offset);
                offset = skipLeb(bytes, flags.offset);
                if (flags.value & 1) offset = skipLeb(bytes, offset);
            } else if (kind === 0x03) {
                offset += 2;
            } else {
                throw new Error(`Unknown WebAssembly import kind ${kind}`);
            }
        }
    }

    const types = readU32(bytes, typeSection.contentStart);
    const newType = types.value;
    const definedFunctions = readU32(bytes, functionSection.contentStart);
    const copyFunction = importedFunctions + definedFunctions.value;
    const fillFunction = copyFunction + 1;

    const lowered = {copy: 0, fill: 0};
    const bodies = readBodies(bytes, codeSection).map((body) => {
        const out = [];
        let copied = body.start;
        walkInstructions(bytes, firstInstruction(bytes, body), body.end, (kind, start, end) => {
            out.push(...bytes.subarray(copied, start), 0x10, ...encodeU32(kind === 'copy' ? copyFunction : fillFunction));
            copied = end;
            lowered[kind] += 1;
        });
        out.push(...bytes.subarray(copied, body.end));
        return [...encodeU32(out.length), ...out];
    });
    for (const body of [COPY_BODY, FILL_BODY]) bodies.push([...encodeU32(body.length), ...body]);

    const typeContent = [
        ...encodeU32(types.value + 1),
        ...bytes.subarray(types.offset, typeSection.end),
        0x60, 3, I32, I32, I32, 0,
    ];
    const functionContent = [
        ...encodeU32(definedFunctions.value + 2),
        ...bytes.subarray(definedFunctions.offset, functionSection.end),
        ...encodeU32(newType),
        ...encodeU32(newType),
    ];
    const codeContent = vector(bodies.length, bodies.flat());

    const replaced = new Map([
        [typeSection, section(SECTION_TYPE, typeContent)],
        [functionSection, section(SECTION_FUNCTION, functionContent)],
        [codeSection, section(SECTION_CODE, codeContent)],
    ]);
    const parts = [bytes.subarray(0, 8)];
    for (const entry of sections) {
        const replacement = replaced.get(entry);
        parts.push(replacement ? Uint8Array.from(replacement) : bytes.subarray(entry.start, entry.end));
    }
    const length = parts.reduce((total, part) => total + part.byteLength, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return {bytes: output, lowered};
}
