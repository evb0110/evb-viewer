/**
 * Decodes a quoted string from djvused or ddjvu output: escaped controls and
 * quotes, and runs of octal escapes as the UTF-8 bytes of one text.
 */
export function decodeDjvuString(raw: string) {
    if (!raw.includes('\\')) {
        return raw;
    }
    let decoded = '';
    let octalBytes: number[] = [];

    function flushOctalBytes() {
        if (octalBytes.length === 0) {
            return;
        }
        decoded += Buffer.from(octalBytes).toString('utf8');
        octalBytes = [];
    }

    for (let index = 0; index < raw.length; index += 1) {
        const character = raw[index] ?? '';
        if (character !== '\\') {
            flushOctalBytes();
            const codePoint = raw.codePointAt(index);
            if (codePoint !== undefined) {
                decoded += String.fromCodePoint(codePoint);
                if (codePoint > 0xffff) {
                    index += 1;
                }
            }
            continue;
        }
        const escaped = raw[index + 1];
        if (escaped === undefined) {
            flushOctalBytes();
            decoded += '\\';
            continue;
        }
        if (/[0-7]/u.test(escaped)) {
            let octal = escaped;
            while (octal.length < 3 && /[0-7]/u.test(raw[index + 1 + octal.length] ?? '')) {
                octal += raw[index + 1 + octal.length];
            }
            octalBytes.push(Number.parseInt(octal, 8));
            index += octal.length;
            continue;
        }
        flushOctalBytes();
        decoded += ({
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
        } as Record<string, string>)[escaped] ?? escaped;
        index += 1;
    }
    flushOctalBytes();
    return decoded;
}
