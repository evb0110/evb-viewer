import { decodeDocumentRefSegment } from '@app/utils/documentRef';
import { createBrowserSafeId } from '@app/utils/browserSafe';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';

const BROWSER_REF_PREFIX = 'browser://documents/';

function getDocumentFileName(ref: string) {
    const trimmed = ref.startsWith(BROWSER_REF_PREFIX)
        ? ref.slice(BROWSER_REF_PREFIX.length)
        : ref;

    return decodeDocumentRefSegment(trimmed.split('/').at(-1) ?? 'document');
}

export function createBrowserDocumentRef(fileName: string, id = createBrowserSafeId()): TDocumentRef {
    const ref = `${BROWSER_REF_PREFIX}${id}/${encodeURIComponent(fileName)}`;
    const parsed = parseDocumentRef(ref);
    if (parsed === null) {
        throw new Error('Failed to create a browser document reference');
    }
    return parsed;
}

/** The id a browser ref names: its store directory, or the key of its file handle. */
export function browserDocumentRefId(ref: string) {
    const id = ref.startsWith(BROWSER_REF_PREFIX) ? ref.slice(BROWSER_REF_PREFIX.length).split('/')[0] : undefined;
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new TypeError(`Not a browser document ref: ${ref}`);
    return id;
}

export function isBrowserDocumentRef(path: string) {
    return path.startsWith(BROWSER_REF_PREFIX);
}

export function getBrowserDocumentFileName(path: string) {
    return getDocumentFileName(path);
}
