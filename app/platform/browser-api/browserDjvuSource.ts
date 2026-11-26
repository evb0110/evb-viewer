import type { IDjvuPageSize } from '@contracts/electronApiDjvu';
import type { IDjvuWorker } from '@app/platform/browser-api/browserDjvuWorkerClient';
import {
    isIndirectDjvuHeader,
    parseDjvuPageHead,
    readDjvuSourceLayout,
    type IDjvuComponentFiles,
    type IDjvuSourceLayout,
    type TDjvuRangeReader,
} from '@djvu-core/djvuSourceLayout';

export {
    isIndirectDjvuHeader,
    parseDjvuPageHead,
    readDjvuSourceLayout as readBrowserDjvuSourceLayout,
};
export type {
    IDjvuComponentFiles,
    IDjvuSourceLayout as IBrowserDjvuSourceLayout,
    TDjvuRangeReader,
};

const workerPageTables = new WeakMap<IDjvuWorker, IDjvuPageSize[]>();

/** Records the page table a worker's document was opened with. */
export function setDjvuWorkerPageSizes(worker: IDjvuWorker, pageSizes: IDjvuPageSize[]) {
    workerPageTables.set(worker, pageSizes);
}

/**
 * The page table read when the worker opened its document. Every caller
 * shares the one array, so callers read it and never modify it.
 */
export function getDjvuWorkerPageSizes(worker: IDjvuWorker): Promise<IDjvuPageSize[]> {
    const pageSizes = workerPageTables.get(worker);
    return pageSizes
        ? Promise.resolve(pageSizes)
        : Promise.reject(new Error('The DjVu worker was not opened by createDjvuWorkerFromPath'));
}
