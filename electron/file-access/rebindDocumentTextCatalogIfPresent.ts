import {access} from 'node:fs/promises';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {rebindDocumentTextCatalogRevision} from '@electron/features/ocr/public/index';
import {rebindSearchIndexesFromNative as rebindSearchIndexes} from '@electron/features/search/publicNative';

/** Annotation/metadata saves preserve text truth and only re-key its revision. */
export async function rebindDocumentTextCatalogIfPresent(
    workingCopyPath: string,
    previousRevision: TDocumentRevisionToken | undefined,
    nextRevision: TDocumentRevisionToken,
) {
    if (!previousRevision) {
        return false;
    }
    const manifestPath = `${workingCopyPath}.ocr/manifest.json`;
    const hasOcrCatalog = await access(manifestPath).then(() => true).catch(() => false);
    if (hasOcrCatalog) {
        await rebindDocumentTextCatalogRevision(workingCopyPath, previousRevision, nextRevision);
    }
    const reboundSearch = await rebindSearchIndexes(
        workingCopyPath,
        previousRevision,
        nextRevision,
    );
    return hasOcrCatalog || reboundSearch;
}
