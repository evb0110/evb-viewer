import { realpathSync } from 'fs';
import { resolve } from 'path';

/** Resolve an exact native path; URI decoding belongs to the URI input boundary. */
export function normalizeExistingPath(filePath: string) {
    if (!filePath) {
        return null;
    }
    try {
        return realpathSync.native(resolve(filePath));
    } catch {
        return null;
    }
}
