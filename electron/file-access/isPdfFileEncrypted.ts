import {
    open,
    stat,
} from 'fs/promises';
import {
    containsPdfEncryptMarker,
    PDF_ENCRYPT_SCAN_REGION_BYTES,
} from '@pdf-core';

async function readRegion(
    handle: Awaited<ReturnType<typeof open>>,
    offset: number,
    length: number,
) {
    const bytes = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < bytes.byteLength) {
        const result = await handle.read(
            bytes,
            bytesRead,
            bytes.byteLength - bytesRead,
            offset + bytesRead,
        );
        if (result.bytesRead === 0) {
            break;
        }
        bytesRead += result.bytesRead;
    }
    return bytes.subarray(0, bytesRead);
}

/**
 * A bounded hint used to avoid starting the writer for ordinary PDFs. The
 * writer remains the only decryptor. A positive result is never treated as
 * proof that a password is valid.
 */
export async function isPdfFileEncrypted(filePath: string) {
    const stats = await stat(filePath);
    const handle = await open(filePath, 'r');
    try {
        const headSize = Math.min(PDF_ENCRYPT_SCAN_REGION_BYTES, stats.size);
        const head = await readRegion(handle, 0, headSize);
        if (containsPdfEncryptMarker(head)) {
            return true;
        }

        if (stats.size > headSize) {
            const tailSize = Math.min(PDF_ENCRYPT_SCAN_REGION_BYTES, stats.size - headSize);
            const tail = await readRegion(handle, stats.size - tailSize, tailSize);
            if (containsPdfEncryptMarker(tail)) {
                return true;
            }
        }

        return false;
    } finally {
        await handle.close();
    }
}
