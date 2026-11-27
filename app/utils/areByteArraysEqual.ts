const WORD_BYTES = 8;

function compareBytes(left: Uint8Array, right: Uint8Array, start: number, end: number) {
    for (let index = start; index < end; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

export function areByteArraysEqual(left: Uint8Array | null | undefined, right: Uint8Array | null | undefined) {
    if (!left || !right) {
        return false;
    }
    if (left === right) {
        return true;
    }
    if (left.byteLength !== right.byteLength) {
        return false;
    }

    let index = 0;
    const byteLength = left.byteLength;
    const leftAlignment = left.byteOffset % WORD_BYTES;
    const rightAlignment = right.byteOffset % WORD_BYTES;

    if (leftAlignment === rightAlignment) {
        const prefixLength = leftAlignment === 0 ? 0 : Math.min(WORD_BYTES - leftAlignment, byteLength);
        if (!compareBytes(left, right, 0, prefixLength)) {
            return false;
        }
        index = prefixLength;

        const wordCount = Math.floor((byteLength - index) / WORD_BYTES);
        if (wordCount > 0) {
            const leftWords = new BigUint64Array(left.buffer, left.byteOffset + index, wordCount);
            const rightWords = new BigUint64Array(right.buffer, right.byteOffset + index, wordCount);
            for (let wordIndex = 0; wordIndex < wordCount; wordIndex += 1) {
                if (leftWords[wordIndex] !== rightWords[wordIndex]) {
                    return false;
                }
            }
            index += wordCount * WORD_BYTES;
        }
    }

    return compareBytes(left, right, index, byteLength);
}
