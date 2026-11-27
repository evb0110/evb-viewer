export function includesAsciiToken(data: Uint8Array, token: string, start: number, end: number) {
    const tokenBytes = Buffer.from(token, 'ascii');
    const lastStart = end - tokenBytes.byteLength;
    for (let offset = start; offset <= lastStart; offset += 1) {
        let matches = true;
        for (let index = 0; index < tokenBytes.byteLength; index += 1) {
            if (data[offset + index] !== tokenBytes[index]) {
                matches = false;
                break;
            }
        }
        if (matches) {
            return true;
        }
    }
    return false;
}
