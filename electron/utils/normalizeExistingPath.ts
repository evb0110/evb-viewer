import { existsSync } from 'fs';
import { resolve } from 'path';

/** Keep the opened spelling; canonical identity belongs to lookup, URI decoding to admission. */
export function normalizeExistingPath(filePath: string) {
    return filePath && existsSync(filePath) ? resolve(filePath) : null;
}
