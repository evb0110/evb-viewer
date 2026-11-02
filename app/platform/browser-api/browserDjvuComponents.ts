import type { TDocumentRef } from '@contracts/documentRef';
import { SerializableError } from '@contracts/serializableError';
import {
    isIndirectDjvuHeader,
    type IDjvuComponentFiles,
} from '@app/platform/browser-api/browserDjvuSource';
import { getExtension } from '@app/platform/browser-api/browserFileName';
import { isSupportedOpenExtension } from '@pdf-core/documentOpenFileTypes';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';

/**
 * The sibling files of indirect DjVu documents opened in this session.
 *
 * An indirect index names its pages and shared dictionaries as separate
 * files. Desktop reads them from the index's folder; a browser page can read
 * only the files the person selected, so the index is opened together with
 * them and each name resolves to the selected file of that name.
 */
const componentFilesByIndex = new Map<string, IDjvuComponentFiles>();
// An index whose record leaves the store cannot reopen; its files go with it.
browserDocumentStore.onDocumentRecordRemoved(ref => componentFilesByIndex.delete(ref));

const DJVU_FILE_NAME_PATTERN = /\.djvu?$/iu;
const DJVU_HEADER_BYTES = 25;

function baseName(name: string) {
    return name.split(/[\\/]/u).at(-1) ?? name;
}

function createComponentFiles(files: readonly File[]): IDjvuComponentFiles {
    const filesByName = new Map<string, File>();
    for (const file of files) {
        if (!filesByName.has(file.name)) {
            filesByName.set(file.name, file);
        }
    }
    return {async readComponent(name, length) {
        // An index may name a component by a relative path; the picked
        // file carries only its own name.
        const file = filesByName.get(name) ?? filesByName.get(baseName(name));
        if (!file) {
            throw new SerializableError({
                code: 'djvu-components-required',
                message: `The DjVu page file ${name} was not selected with its index.`,
            });
        }
        const part = length === undefined ? file : file.slice(0, length);
        return new Uint8Array(await part.arrayBuffer());
    }};
}

export function getBrowserDjvuComponentFiles(indexRef: TDocumentRef) {
    return componentFilesByIndex.get(indexRef) ?? null;
}

export function setBrowserDjvuComponentFiles(indexRef: TDocumentRef, files: readonly File[]) {
    componentFilesByIndex.set(indexRef, createComponentFiles(files));
}

async function isIndirectDjvuIndexFile(file: File) {
    return DJVU_FILE_NAME_PATTERN.test(file.name)
        && file.size >= DJVU_HEADER_BYTES
        && isIndirectDjvuHeader(new Uint8Array(await file.slice(0, DJVU_HEADER_BYTES).arrayBuffer()));
}

/** A selected PDF or image is a document of its own, never a DjVu component. */
function isOtherOpenDocument(file: File) {
    const extension = getExtension(file.name);
    return isSupportedOpenExtension(extension) && !DJVU_FILE_NAME_PATTERN.test(file.name);
}

/**
 * Recognizes a selection of one indirect DjVu index and the files beside it:
 * the index is the document, every other selected file is a component it may
 * name. A selection that also holds a PDF or image is a batch of documents.
 */
export async function findIndirectDjvuSelection<T extends {file: File}>(picked: readonly T[]) {
    if (picked.length < 2 || picked.some(entry => isOtherOpenDocument(entry.file))) {
        return null;
    }
    const indexes: T[] = [];
    for (const entry of picked) {
        if (await isIndirectDjvuIndexFile(entry.file)) {
            indexes.push(entry);
        }
    }
    const index = indexes.length === 1 ? indexes[0] : undefined;
    return index
        ? {
            index,
            components: picked.filter(entry => entry !== index).map(entry => entry.file),
        }
        : null;
}
