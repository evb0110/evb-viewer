import type {
    ICompactSearchIndex,
    ICompactSearchIndexPayload,
    ILoadCompactSearchIndexOptions,
} from '@electron/features/search/searchIndexSidecar';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IPdfSearchIndex} from '@electron/features/search/searchIndexTypes';
// fallow-ignore-next-line unused-export -- retained for worker-safe external consumers.
export {extractTextFromPdf} from '@electron/features/search/extractTextFromPdf';

// fallow-ignore-next-line unused-export -- retained for worker-safe external consumers.
export {loadPdfjsTextExtractor} from '@electron/features/search/loadPdfjsTextExtractor';
export {classifyXlargeSearchPathFromFile} from '@electron/features/search/xlargeSearchClassification';
// keep the packaged sidecar lazy and module-local.
const loadSearchIndexSidecar = () => import('./searchIndexSidecar');
interface ISearchIndexBuilderPublic { loadSearchIndex: (pdfPath: string, expectedRevision?: TDocumentRevisionToken) => Promise<IPdfSearchIndex | null>; }
interface IRebindSearchIndexes { rebindSearchIndexes: (pdfPath: string, previousRevision: TDocumentRevisionToken, nextRevision: TDocumentRevisionToken) => Promise<boolean>; }
interface ISearchIndexSidecar {
    loadCompactSearchIndex: (pdfPath: string, options: ILoadCompactSearchIndexOptions) => Promise<ICompactSearchIndex | null>;
    persistCompactSearchIndex: (pdfPath: string, payload: ICompactSearchIndexPayload, signal?: AbortSignal) => Promise<void>;
}
export const NATIVE_COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER = 1;
export function getNativeCompactSearchIndexPath(pdfPath: string) {
    return `${pdfPath}.index.evb-search-v2.bin`;
}
export async function loadNativeCompactSearchIndex(
    pdfPath: string,
    options: ILoadCompactSearchIndexOptions = {},
) {
    const module = await loadSearchIndexSidecar() as ISearchIndexSidecar;
    return module.loadCompactSearchIndex(pdfPath, options);
}
export async function persistNativeCompactSearchIndex(
    pdfPath: string,
    payload: ICompactSearchIndexPayload,
    signal?: AbortSignal,
) {
    const module = await loadSearchIndexSidecar() as ISearchIndexSidecar;
    return module.persistCompactSearchIndex(pdfPath, payload, signal);
}
export {
    classifySearchIndexOperation,
    invalidateSearchIndexSidecars,
} from '@electron/features/search/searchIndexOperationPolicy';
export {stringifyLegacyJsonSearchIndex} from '@electron/features/search/stringifyLegacyJsonSearchIndex';
export {SEARCH_INDEX_SCHEMA_VERSION} from '@electron/features/search/searchIndexSchemaVersion';

// keep the builder lazy and module-local.
const loadSearchIndexBuilderPublic = () => import('./searchIndexBuilderPublic');
// keep rebinding lazy and module-local.
const loadRebindSearchIndexes = () => import('./rebindSearchIndexes');

export async function loadSearchIndex(
    ...args: Parameters<ISearchIndexBuilderPublic['loadSearchIndex']>
) {
    const module = await loadSearchIndexBuilderPublic() as ISearchIndexBuilderPublic;
    return module.loadSearchIndex(...args);
}

export async function rebindSearchIndexesFromNative(
    ...args: Parameters<IRebindSearchIndexes['rebindSearchIndexes']>
) {
    const module = await loadRebindSearchIndexes();
    return module.rebindSearchIndexes(...args);
}
// fallow-ignore-next-line unused-type -- retained for the worker-safe public contract.
export type {IPageTextWithWordBoxes} from '@electron/features/search/extractTextWithPdfjs';
