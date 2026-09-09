import {randomUUID} from 'crypto';
import {join} from 'path';
import type { IScanCleanupPreviewRequest } from '@contracts/electronApiScanCleanup';
import type {IPdfPageSizeStore} from '@electron/pdf/pdfPageSizes';
import {resolveRasterHandoff} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import type {
    IDetectedPageRaster,
    IScanCleanupPageRasterSource,
} from '@evb/scan-cleanup/core/types';
import { detectPageRasterFromPageSize } from '@evb/scan-cleanup/core/types';
import {
    RAW_RASTER_RETENTION_PREFIX,
    RASTER_PAGE_SOURCE_CACHE_LIMIT,
    RASTER_PAGE_SOURCE_PROBE_BATCH_PAGES,
    PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES,
    rasterFromLegacyProbe,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {PREVIEW_DPI} from '@evb/scan-cleanup/core/detection';
import {readScanCleanupPngDimensions as readPngDimensions} from '@evb/scan-cleanup/core/rasterValidation';
import type {
    IRetainedDocument,
    IRetainedRawRaster,
    IScanCleanupRasterRetention,
    IScanCleanupRasterDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {
    readPreviewBytes,
    readPreviewMetadata,
    renderUnretainedRawRaster,
    createScanCleanupPathOperationQueue,
    createScanCleanupReadLifecycle,
    closeScanCleanupPageSizeStores,
    readRetainedRaster,
    createScanCleanupRasterKey,
    createScanCleanupRasterRemovalCoordinator,
    stableScanCleanupRasterPath,
    requireScanCleanupRasterDependencies,
    type IScanCleanupRetainedReadOperation,
} from '@electron/features/scan-cleanup/scanCleanupRasterRetentionIo';
import {
    resolveScanCleanupDocumentMeasurement,
    resolveScanCleanupDocumentPageMeasurement,
    createScanCleanupRasterMeasurements,
} from '@electron/features/scan-cleanup/scanCleanupRasterMeasurement';
const logger = createLogger('scan-cleanup-raster-retention');
export function scanCleanupRasterRetention(
    dependencies: IScanCleanupRasterDependencies,
): IScanCleanupRasterRetention {
    const requiredDependencies = requireScanCleanupRasterDependencies(dependencies);
    const {
        fileSystem,
        getAvailableScratchBytes,
        getSourceStatIdentity,
    } = requiredDependencies;
    const documents = new Map<string, IRetainedDocument>(); const opening = new Map<string, Promise<IRetainedDocument>>();
    const rasters = new Map<string, IRetainedRawRaster>(); const adoptedRasters = new Set<string>();
    let retainedBytes = 0;
    let root: Promise<string> | null = null; let budget: Promise<number> | null = null;
    const pendingStoreClosures = new Set<Promise<void>>();
    const documentGenerations = new WeakMap<IRetainedDocument, number>();
    const inFlightReads = new Map<string, IScanCleanupRetainedReadOperation>();
    const pendingRasterReleases = new Set<symbol>();
    const rasterClaims = new Map<string, Set<string>>();
    const canceledClaims = new Set<string>();
    const activeClaimOperations = new Map<string, number>();
    const claimFenceKey = (document: IRetainedDocument, claimId: string) => [
        claimId,
        document.sourcePdfPath,
        document.documentRevision,
        document.sourceStatIdentity,
    ].join('\u0000');
    const beginClaimOperation = (document: IRetainedDocument, claimId: string) => {
        const key = claimFenceKey(document, claimId);
        activeClaimOperations.set(key, (activeClaimOperations.get(key) ?? 0) + 1);
        return key;
    };
    const finishClaimOperation = (key: string) => {
        const active = activeClaimOperations.get(key) ?? 0;
        if (active <= 1) activeClaimOperations.delete(key);
        else activeClaimOperations.set(key, active - 1);
        if (!activeClaimOperations.has(key)) canceledClaims.delete(key);
    };
    const enqueuePathOperation = createScanCleanupPathOperationQueue();
    const removal = createScanCleanupRasterRemovalCoordinator({
        enqueue: enqueuePathOperation,
        rasters,
        removePath: fileSystem.rm,
    });
    const {
        pendingCleanups: pendingPathCleanups,
        remove,
        removeQuietly,
        removeRaster,
    } = removal;
    const pendingDocumentCleanups = new Set<IRetainedDocument>();
    const readLifecycle = createScanCleanupReadLifecycle();
    let disposed = false;
    const finishRead = (key: string, operation: IScanCleanupRetainedReadOperation) => {
        if (inFlightReads.get(key)?.token === operation.token) {
            inFlightReads.delete(key);
        }
        if (pendingRasterReleases.delete(operation.token)) {
            if (rasters.get(key) === operation.raster) {
                forget(key, operation.raster);
            }
            removeRaster(operation.raster);
        }
        readLifecycle.finish();
        if (readLifecycle.pendingCount === 0) {
            for (const document of pendingDocumentCleanups) {
                if (![...inFlightReads.values()].some(read => read.raster.document === document)) {
                    pendingDocumentCleanups.delete(document);
                    discard(document);
                }
            }
        }
    };
    const forget = (key: string, raster: IRetainedRawRaster) => {
        rasters.delete(key);
        adoptedRasters.delete(key);
        retainedBytes = Math.max(0, retainedBytes - raster.sizeBytes);
    };
    const ensureRoot = () => {
        root ??= (async () => {
            const path = join(
                dependencies.getTempDir(),
                `${RAW_RASTER_RETENTION_PREFIX}${randomUUID()}-${process.pid}`,
            );
            await fileSystem.rm(path, {
                force: true,
                recursive: true,
            });
            await fileSystem.mkdir(path, {recursive: true});
            return path;
        })();
        return root;
    };
    const resolveBudgetBytes = () => {
        budget ??= ensureRoot()
            .then(path => resolveRasterHandoff(
                [],
                path,
                getAvailableScratchBytes,
            ))
            .then(handoff => handoff.budgetBytes ?? 0);
        return budget;
    };
    const removeDocumentWhenIdle = (document: IRetainedDocument) => {
        if (documents.get(document.sourcePdfPath) === document) documents.delete(document.sourcePdfPath);
        for (const [
            key,
            raster,
        ] of rasters) {
            if (raster.document === document) {
                forget(key, raster);
                rasterClaims.delete(key);
                removeRaster(raster);
            }
        }
        document.lifetime.abort(new DOMException('Scan cleanup document was closed', 'AbortError'));
        if ([...inFlightReads.values()].some(read => read.raster.document === document)) {
            pendingDocumentCleanups.add(document);
            return;
        }
        const storesClosed = closeScanCleanupPageSizeStores(document, pendingStoreClosures);
        void Promise.all([
            document.dir,
            storesClosed,
        ]).then(([directory]) => remove(directory), () => undefined);
    };
    const readRetained = async <TValue>(
        document: IRetainedDocument,
        pageNumber: number,
        dpi: number,
        load: (raster: IRetainedRawRaster) => Promise<TValue>,
        refresh: (raster: IRetainedRawRaster, value: TValue) => IRetainedRawRaster,
    ) => {
        const key = createScanCleanupRasterKey(document, pageNumber, dpi);
        const raster = rasters.get(key);
        if (!raster || document.removeWhenIdle) {
            return null;
        }
        return readRetainedRaster({
            key,
            generation: documentGenerations.get(document) ?? 0,
            document,
            raster,
            rasters,
            inFlightReads,
            pendingRasterReleases,
            currentGeneration: () => documentGenerations.get(document) ?? 0,
            beginRead: readLifecycle.begin,
            finishRead,
            adjustBytes: delta => { retainedBytes += delta; },
            adopt: keyToAdopt => adoptedRasters.add(keyToAdopt),
            load,
            refresh,
        });
    };
    const discard = (document: IRetainedDocument, force = false) => {
        documentGenerations.set(document, (documentGenerations.get(document) ?? 0) + 1);
        document.removeWhenIdle = true;
        if (document.pinned > 0 && !force) {
            return;
        }
        removeDocumentWhenIdle(document);
    };
    const prune = async () => {
        const budgetBytes = await resolveBudgetBytes();
        for (const [
            key,
            raster,
        ] of rasters) {
            if (retainedBytes <= budgetBytes) {
                return;
            }
            if (raster.document.pinned > 0) continue;
            forget(key, raster);
            rasterClaims.delete(key);
            removeRaster(raster);
        }
    };
    const resolveDocument = async (
        request: Pick<IScanCleanupPreviewRequest, 'sourcePdfPath' | 'documentRevision'>,
        claimId?: string,
    ) => {
        if (disposed) {
            throw new DOMException('Scan cleanup raster retention is disposed', 'AbortError');
        }
        const sourceStatIdentity = await getSourceStatIdentity(request.sourcePdfPath);
        if (disposed) {
            throw new DOMException('Scan cleanup raster retention is disposed', 'AbortError');
        }
        const current = documents.get(request.sourcePdfPath);
        if (
            current
            && current.documentRevision === request.documentRevision
        && current.sourceStatIdentity === sourceStatIdentity
        && !current.removeWhenIdle
        ) {
            current.pinned += 1;
            if (claimId !== undefined) current.claims.set(claimId, (current.claims.get(claimId) ?? 0) + 1);
            return current;
        }
        if (current) discard(current);
        if (disposed) {
            throw new DOMException('Scan cleanup raster retention is disposed', 'AbortError');
        }
        const claims = new Map<string, number>();
        if (claimId !== undefined) claims.set(claimId, 1);
        const document: IRetainedDocument = {
            dir: ensureRoot().then(async path => {
                if (disposed) {
                    throw new DOMException('Scan cleanup raster retention is disposed', 'AbortError');
                }
                const dir = join(path, randomUUID());
                await fileSystem.mkdir(dir, {recursive: true});
                if (disposed) {
                    await fileSystem.rm(dir, {
                        force: true,
                        recursive: true,
                    });
                    throw new DOMException('Scan cleanup raster retention is disposed', 'AbortError');
                }
                return dir;
            }),
            documentRevision: request.documentRevision,
            lifetime: new AbortController(),
            sourceStatIdentity,
            pageCount: null,
            previewPageSizes: null,
            sourceDpiByPage: new Map(),
            rasterPages: null,
            rasterPageSource: null,
            rasterPageSourceStore: null,
            pageGeometryDpi: null,
            pageSizeStores: new Set(),
            rasterPageByPage: new Map(),
            pinned: 1,
            claims,
            removeWhenIdle: false,
            sourcePdfPath: request.sourcePdfPath,
        };
        documents.set(request.sourcePdfPath, document);
        return document;
    };
    const measurements = createScanCleanupRasterMeasurements({
        dependencies,
        documentGenerations,
        disposed: () => disposed,
    });
    const {
        resolvePageCount,
        resolvePreviewPageSizes,
        resolvePageSizeStore,
    } = measurements;
    const resolveRasterPageSource = (
        document: IRetainedDocument,
        signal: AbortSignal,
    ) => resolveScanCleanupDocumentMeasurement(
        {
            read: () => document.rasterPageSource,
            write: value => {
                document.rasterPageSource = value;
            },
        },
        signal,
        async () => {
            let pageSizeStore: IPdfPageSizeStore | null = null;
            try {
                pageSizeStore = await resolvePageSizeStore(document, signal);
                document.lifetime.signal.throwIfAborted();
                document.rasterPageSourceStore = pageSizeStore;
            } catch (error) {
                logger.warn(`Scan cleanup could not open page geometry for raster facts: ${getErrorMessage(error)}`);
            }
            const rasterPageSizeStore = pageSizeStore?.fork?.() ?? pageSizeStore;
            if (rasterPageSizeStore !== null && rasterPageSizeStore !== pageSizeStore) {
                document.pageSizeStores.add(rasterPageSizeStore);
            }
            const serializePageReads = rasterPageSizeStore === pageSizeStore;
            let pageReadTail = Promise.resolve();
            const readPageSize = async (pageNumber: number) => {
                if (rasterPageSizeStore === null) {
                    return undefined;
                }
                if (!serializePageReads) {
                    return rasterPageSizeStore.getPage(pageNumber);
                }
                const read = pageReadTail.then(() => rasterPageSizeStore.getPage(pageNumber));
                pageReadTail = read.then(() => undefined, () => undefined);
                return read;
            };
            const pageRasterCache = new Map<number, Promise<IDetectedPageRaster | undefined>>();
            const pendingRasterReads = new Map<number, {
                reject: (error: unknown) => void;
                resolve: (raster: IDetectedPageRaster | undefined) => void
            }>();
            let rasterReadFlushScheduled = false;
            let documentDpi: number | null = null;
            const observeRaster = (raster: IDetectedPageRaster | undefined) => {
                if (
                    raster !== undefined
                    && Number.isFinite(raster.dpi)
                    && raster.dpi > 0
                ) {
                    documentDpi = Math.max(documentDpi ?? 0, raster.dpi);
                }
                return raster;
            };
            const flushRasterReads = () => {
                rasterReadFlushScheduled = false;
                if (pendingRasterReads.size === 0) {
                    return;
                }
                const entries = [...pendingRasterReads.entries()]
                    .slice(0, RASTER_PAGE_SOURCE_PROBE_BATCH_PAGES);
                for (const [pageNumber] of entries) pendingRasterReads.delete(pageNumber);
                const pageNumbers = entries.map(([pageNumber]) => pageNumber);
                void Promise.all(pageNumbers.map(async pageNumber => {
                    try {
                        return await readPageSize(pageNumber);
                    } catch (error) {
                        if (document.lifetime.signal.aborted) throw error;
                        logger.warn(`Scan cleanup could not read page ${String(pageNumber)} geometry for raster facts: ${getErrorMessage(error)}`);
                        return undefined;
                    }
                })).then(async pageSizes => {
                    const rasters = pageSizes.map(pageSize => (
                        pageSize === undefined ? undefined : detectPageRasterFromPageSize(pageSize)
                    ));
                    const missingPageNumbers = pageNumbers.filter((_, index) => rasters[index] === undefined);
                    const probed = missingPageNumbers.length === 0 || dependencies.detectRasterPages === undefined
                        ? undefined
                        : await dependencies.detectRasterPages(
                            document.sourcePdfPath,
                            document.lifetime.signal,
                            missingPageNumbers,
                        );
                    for (const dpi of probed?.sourceDpiByPage?.values() ?? []) {
                        if (Number.isFinite(dpi) && dpi > 0) {
                            documentDpi = Math.max(documentDpi ?? 0, dpi);
                        }
                    }
                    for (const [
                        index,
                        [
                            pageNumber,
                            waiter,
                        ],
                    ] of entries.entries()) {
                        waiter.resolve(observeRaster(
                            rasters[index] ?? (probed === undefined
                                ? undefined
                                : rasterFromLegacyProbe(probed, pageNumber)),
                        ));
                    }
                }, error => {
                    for (const [
                        ,
                        waiter,
                    ] of entries) {
                        waiter.reject(error);
                    }
                }).finally(() => {
                    if (pendingRasterReads.size > 0) {
                        rasterReadFlushScheduled = true;
                        void Promise.resolve().then(flushRasterReads);
                    }
                }).catch(() => undefined);
            };
            const readRasterPage = (pageNumber: number) => new Promise<IDetectedPageRaster | undefined>((resolve, reject) => {
                pendingRasterReads.set(pageNumber, {
                    resolve,
                    reject,
                });
                if (!rasterReadFlushScheduled) {
                    rasterReadFlushScheduled = true;
                    void Promise.resolve().then(flushRasterReads);
                }
            });
            const getPageRaster = (pageNumber: number) => {
                const cached = pageRasterCache.get(pageNumber);
                if (cached !== undefined) {
                    pageRasterCache.delete(pageNumber);
                    pageRasterCache.set(pageNumber, cached);
                    return cached;
                }
                const pending = readRasterPage(pageNumber);
                pageRasterCache.set(pageNumber, pending);
                if (pageRasterCache.size > RASTER_PAGE_SOURCE_CACHE_LIMIT) {
                    const oldest = pageRasterCache.keys().next().value;
                    if (oldest !== undefined && oldest !== pageNumber) {
                        pageRasterCache.delete(oldest);
                    }
                }
                void pending.catch(() => {
                    if (pageRasterCache.get(pageNumber) === pending) {
                        pageRasterCache.delete(pageNumber);
                    }
                });
                return pending;
            };
            const source: IScanCleanupPageRasterSource = {
                detected: dependencies.isRasterDetectionAvailable?.()
                    ?? dependencies.detectRasterPages !== undefined,
                get documentDpi() {
                    return Math.max(documentDpi ?? 0, document.pageGeometryDpi ?? 0) || null;
                },
                getPageRaster,
            };
            return source;
        },
    );
    const resolveSourceDpi = (
        document: IRetainedDocument,
        pageNumber: number,
        signal: AbortSignal,
    ) => resolveScanCleanupDocumentPageMeasurement(
        document.sourceDpiByPage,
        pageNumber,
        signal,
        async () => dependencies.detectSourceDpi === undefined
            ? null
            : dependencies.detectSourceDpi(
                document.sourcePdfPath,
                pageNumber,
                document.lifetime.signal,
            ),
    );
    const resolvePreviewRasterPages = (document: IRetainedDocument, signal: AbortSignal) => resolveScanCleanupDocumentMeasurement(
        {
            read: () => document.rasterPages,
            write: value => {
                document.rasterPages = value;
            },
        },
        signal,
        async () => {
            if (!dependencies.detectRasterPages) {
                return {
                    detected: false,
                    pages: new Set<number>(),
                    bilevelLayerPages: new Set<number>(),
                    dominantBilevelLayerPages: new Set<number>(),
                    backgroundDpiByPage: new Map<number, number>(),
                };
            }
            const totalPages = await resolvePageCount(document, signal);
            if (totalPages > PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES) {
                return {
                    detected: false,
                    pages: new Set<number>(),
                    bilevelLayerPages: new Set<number>(),
                    dominantBilevelLayerPages: new Set<number>(),
                    backgroundDpiByPage: new Map<number, number>(),
                };
            }
            let pageNumbers: number[] | undefined;
            if (totalPages <= PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES) {
                pageNumbers = [];
                for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
                    pageNumbers.push(pageNumber);
                }
            }
            return dependencies.detectRasterPages(
                document.sourcePdfPath,
                document.lifetime.signal,
                pageNumbers,
            );
        },
    );
    const resolveRasterPage = (
        document: IRetainedDocument,
        pageNumber: number,
        signal: AbortSignal,
    ) => resolveScanCleanupDocumentPageMeasurement(
        document.rasterPageByPage,
        pageNumber,
        signal,
        async () => {
            if (!dependencies.detectRasterPages) {
                return {
                    detected: false,
                    pages: new Set<number>(),
                    bilevelLayerPages: new Set<number>(),
                    dominantBilevelLayerPages: new Set<number>(),
                    backgroundDpiByPage: new Map<number, number>(),
                };
            }
            return dependencies.detectRasterPages(
                document.sourcePdfPath,
                document.lifetime.signal,
                [pageNumber],
            );
        },
    );
    return {
        openDocument(
            request: Pick<IScanCleanupPreviewRequest, 'sourcePdfPath' | 'documentRevision'>,
            claimId?: string,
        ) {
            if (disposed) {
                return Promise.reject(new DOMException('Scan cleanup raster retention is disposed', 'AbortError'));
            }
            const pending = (opening.get(request.sourcePdfPath) ?? Promise.resolve())
                .then(() => resolveDocument(request, claimId), () => resolveDocument(request, claimId));
            opening.set(request.sourcePdfPath, pending);
            void pending.finally(() => {
                if (opening.get(request.sourcePdfPath) === pending) {
                    opening.delete(request.sourcePdfPath);
                }
            }).catch(() => undefined);
            return pending;
        },
        pageCount: resolvePageCount,
        previewPageSizes: resolvePreviewPageSizes,
        pageSizeStore: resolvePageSizeStore,
        sourceDpi: resolveSourceDpi,
        previewRasterPages: resolvePreviewRasterPages,
        rasterPageSource: resolveRasterPageSource,
        rasterPage: resolveRasterPage,
        async rasterScratchPath(document: IRetainedDocument, pageNumber: number, dpi: number) {
            return join(await document.dir, `page-${pageNumber}-${dpi}.${randomUUID()}.part.png`);
        },
        async stagedRasterPath(document: IRetainedDocument, pageNumber: number, dpi: number) {
            return stableScanCleanupRasterPath(await document.dir, pageNumber, dpi);
        },
        async releaseRaster(
            document: IRetainedDocument,
            pageNumber: number,
            dpi: number,
            claimId?: string,
        ) {
            const key = createScanCleanupRasterKey(document, pageNumber, dpi);
            if (claimId !== undefined) {
                const claims = rasterClaims.get(key);
                if (!claims?.delete(claimId)) {
                    return;
                }
                if (claims.size > 0) {
                    return;
                }
                rasterClaims.delete(key);
            }
            if (adoptedRasters.has(key)) {
                return;
            }
            const raster = rasters.get(key);
            if (raster === undefined) {
                const read = inFlightReads.get(key);
                if (read !== undefined) {
                    pendingRasterReleases.add(read.token);
                    return;
                }
                if (
                    claimId === undefined
                    && documents.get(document.sourcePdfPath) === document
                    && !document.removeWhenIdle
                ) {
                    const path = stableScanCleanupRasterPath(await document.dir, pageNumber, dpi);
                    await enqueuePathOperation(path, async () => {
                        if (![...rasters.values()].some(current => current.path === path)) {
                            await removeQuietly(path);
                        }
                    });
                }
                return;
            }
            if (raster.document !== document) {
                return;
            }
            const read = inFlightReads.get(key);
            if (read?.raster === raster) {
                pendingRasterReleases.add(read.token);
                return;
            }
            // A page claim is a read/use lease, not a cache eviction request.
            // Keep the retained raster available while its document is still
            // owned by another active operation.
            if (claimId !== undefined && document.pinned > 0 && !document.removeWhenIdle) {
                return;
            }
            forget(key, raster);
            await enqueuePathOperation(raster.path, async () => {
                if (![...rasters.values()].some(current => current.path === raster.path)) {
                    await removeQuietly(raster.path);
                }
            });
        },
        claimRaster(document, pageNumber, dpi, claimId) {
            if ((document.claims.get(claimId) ?? 0) === 0 || document.removeWhenIdle
                || canceledClaims.has(claimFenceKey(document, claimId))) {
                return false;
            }
            const key = createScanCleanupRasterKey(document, pageNumber, dpi);
            if (!rasters.has(key)) {
                return false;
            }
            const claims = rasterClaims.get(key) ?? new Set<string>();
            claims.add(claimId);
            rasterClaims.set(key, claims);
            return true;
        },
        async retainedPaths(document: IRetainedDocument, pageNumbers: readonly number[], dpi: number) {
            const retained = new Map<number, IRetainedRawRaster>();
            if (document.removeWhenIdle) {
                return retained;
            }
            const generation = documentGenerations.get(document) ?? 0;
            for (const pageNumber of pageNumbers) {
                const key = createScanCleanupRasterKey(document, pageNumber, dpi);
                const raster = rasters.get(key);
                if (!raster) {
                    continue;
                }
                try {
                    if (!dependencies.stat) throw new Error('Scan cleanup retained path checks require injected stat'); await dependencies.stat(raster.path);
                } catch {
                    if (rasters.get(key) === raster) {
                        forget(key, raster);
                        rasterClaims.delete(key);
                    }
                    continue;
                }
                if (
                    document.removeWhenIdle
                    || (documentGenerations.get(document) ?? 0) !== generation
                    || rasters.get(key) !== raster
                ) {
                    continue;
                }
                rasters.delete(key);
                rasters.set(key, raster);
                retained.set(pageNumber, raster);
            }
            return retained;
        },
        async materializeRawRaster(document, pageNumber, signal, deps, knownTotalPages, dpi = PREVIEW_DPI, pageSize, claimId) {
            const claimedForRead = claimId !== undefined
                && this.claimRaster(document, pageNumber, dpi, claimId);
            const claimOperationKey = claimedForRead && claimId !== undefined
                ? beginClaimOperation(document, claimId)
                : undefined;
            let retained;
            try {
                retained = await this.read(document, pageNumber, dpi);
            } catch (error) {
                if (claimedForRead) await this.releaseRaster(document, pageNumber, dpi, claimId);
                if (claimOperationKey !== undefined) finishClaimOperation(claimOperationKey);
                throw error;
            }
            if (claimOperationKey !== undefined) finishClaimOperation(claimOperationKey);
            if (retained) {
                return {
                    ...retained.raster,
                    bytes: retained.bytes,
                    totalPages: knownTotalPages ?? await this.pageCount(document, signal),
                };
            }
            if (claimedForRead) await this.releaseRaster(document, pageNumber, dpi, claimId);
            const {
                scratchPath,
                totalPages,
            } = await renderUnretainedRawRaster(
                document,
                pageNumber,
                signal,
                this,
                deps,
                knownTotalPages,
                dpi,
                pageSize,
            );
            const bytes = await readPreviewBytes(scratchPath, dependencies);
            if (signal.aborted) {
                this.remove(scratchPath);
                throw signal.reason;
            }
            const raster = await this.retain({
                document,
                dpi,
                ...readPngDimensions(bytes, undefined, 'preview'),
                pageNumber,
                scratchPath,
                sizeBytes: bytes.byteLength,
            }, claimId);
            return {
                ...raster,
                bytes,
                totalPages,
            };
        },
        async materializeRawRasterPath(document, pageNumber, signal, deps, knownTotalPages, dpi = PREVIEW_DPI, pageSize, claimId) {
            const claimedForRead = claimId !== undefined
                && this.claimRaster(document, pageNumber, dpi, claimId);
            const claimOperationKey = claimedForRead && claimId !== undefined
                ? beginClaimOperation(document, claimId)
                : undefined;
            let retained;
            try {
                retained = await this.readPath(document, pageNumber, dpi);
            } catch (error) {
                if (claimedForRead) await this.releaseRaster(document, pageNumber, dpi, claimId);
                if (claimOperationKey !== undefined) finishClaimOperation(claimOperationKey);
                throw error;
            }
            if (claimOperationKey !== undefined) finishClaimOperation(claimOperationKey);
            if (retained) {
                return retained;
            }
            if (claimedForRead) await this.releaseRaster(document, pageNumber, dpi, claimId);
            const {scratchPath} = await renderUnretainedRawRaster(
                document,
                pageNumber,
                signal,
                this,
                deps,
                knownTotalPages,
                dpi,
                pageSize,
            );
            const metadata = await readPreviewMetadata(scratchPath, deps);
            if (signal.aborted) {
                this.remove(scratchPath);
                throw signal.reason;
            }
            return this.retain({
                document,
                dpi,
                ...metadata,
                pageNumber,
                scratchPath,
            }, claimId);
        },
        async read(document: IRetainedDocument, pageNumber: number, dpi: number) {
            const retained = await readRetained(
                document,
                pageNumber,
                dpi,
                current => readPreviewBytes(current.path, dependencies),
                current => current,
            );
            return retained === null ? null : {
                bytes: retained.value,
                raster: retained.raster,
            };
        },
        async readPath(document: IRetainedDocument, pageNumber: number, dpi: number) {
            const retained = await readRetained(
                document,
                pageNumber,
                dpi,
                current => readPreviewMetadata(current.path, dependencies),
                (current, metadata) => ({
                    ...current,
                    ...metadata,
                }),
            );
            return retained?.raster ?? null;
        },
        async retain(
            rendered: Omit<IRetainedRawRaster, 'path'> & {scratchPath: string},
            claimId?: string,
        ) {
            if (disposed) {
                throw new DOMException('Scan cleanup raster retention is disposed', 'AbortError');
            }
            const generation = documentGenerations.get(rendered.document) ?? 0;
            const path = stableScanCleanupRasterPath(await rendered.document.dir, rendered.pageNumber, rendered.dpi);
            const claimOperationKey = claimId === undefined
                ? undefined
                : beginClaimOperation(rendered.document, claimId);
            try {
                const raster = await enqueuePathOperation(path, async () => {
                    if ((documentGenerations.get(rendered.document) ?? 0) !== generation
                    || (claimId !== undefined && canceledClaims.has(claimFenceKey(rendered.document, claimId)))) {
                        throw new DOMException('Scan cleanup raster publication was invalidated', 'AbortError');
                    }
                    await dependencies.publishRaster(rendered.scratchPath, path, {
                        durable: false,
                        markMutationCommitStarted: false,
                    });
                    if ((documentGenerations.get(rendered.document) ?? 0) !== generation
                    || (claimId !== undefined && canceledClaims.has(claimFenceKey(rendered.document, claimId)))) {
                    // The publication may have replaced a stable path that a
                    // different owner still has indexed and pinned. Only
                    // remove it when no current raster represents that path.
                        if (![...rasters.values()].some(current => current.path === path)) {
                            await removeQuietly(path);
                        }
                        throw new DOMException('Scan cleanup raster publication was invalidated', 'AbortError');
                    }
                    const key = createScanCleanupRasterKey(rendered.document, rendered.pageNumber, rendered.dpi);
                    const previous = rasters.get(key);
                    if (previous) {
                        forget(key, previous);
                    }
                    adoptedRasters.delete(key);
                    const nextRaster: IRetainedRawRaster = {
                        document: rendered.document,
                        dpi: rendered.dpi,
                        height: rendered.height,
                        pageNumber: rendered.pageNumber,
                        path,
                        sizeBytes: rendered.sizeBytes,
                        width: rendered.width,
                    };
                    rasters.set(key, nextRaster);
                    if (claimId !== undefined) {
                        const claims = rasterClaims.get(key) ?? new Set<string>();
                        claims.add(claimId);
                        rasterClaims.set(key, claims);
                    }
                    retainedBytes += nextRaster.sizeBytes;
                    return nextRaster;
                });
                await prune();
                return raster;
            } finally {
                if (claimOperationKey !== undefined) finishClaimOperation(claimOperationKey);
            }
        },
        remove,
        async release(document: IRetainedDocument, claimId?: string) {
            if (claimId !== undefined) {
                for (const [
                    key,
                    claims,
                ] of rasterClaims) {
                    claims.delete(claimId);
                    if (claims.size === 0) rasterClaims.delete(key);
                }
                const claimed = document.claims.get(claimId) ?? 0;
                if (claimed === 0) {
                    const key = claimFenceKey(document, claimId);
                    if (!activeClaimOperations.has(key)) canceledClaims.delete(key);
                    return;
                }
                if (claimed === 1) document.claims.delete(claimId);
                else document.claims.set(claimId, claimed - 1);
                const key = claimFenceKey(document, claimId);
                if (!activeClaimOperations.has(key)) canceledClaims.delete(key);
            }
            document.pinned = Math.max(0, document.pinned - 1);
            if (document.pinned > 0) {
                return;
            }
            if (document.removeWhenIdle) {
                removeDocumentWhenIdle(document);
                return;
            }
            await closeScanCleanupPageSizeStores(document, pendingStoreClosures);
            await prune();
        },
        invalidate(sourcePdfPath: string, documentRevision: string, claimId?: string) {
            const document = documents.get(sourcePdfPath);
            const matchingDocument = document?.documentRevision === documentRevision ? document : undefined;
            if (matchingDocument) {
                if (claimId !== undefined) {
                    const claimed = matchingDocument.claims.get(claimId) ?? 0;
                    const fenceKey = claimFenceKey(matchingDocument, claimId);
                    if (claimed === 0 && !activeClaimOperations.has(fenceKey)) {
                        return;
                    }
                    canceledClaims.add(fenceKey);
                    matchingDocument.claims.delete(claimId);
                    matchingDocument.pinned = Math.max(0, matchingDocument.pinned - claimed);
                    if (matchingDocument.pinned > 0) {
                        return;
                    }
                } else if (matchingDocument.pinned > 1) {
                    return;
                }
                matchingDocument.removeWhenIdle = true;
                documentGenerations.set(matchingDocument, (documentGenerations.get(matchingDocument) ?? 0) + 1);
            }
            for (const [
                key,
                raster,
            ] of rasters) {
                if (
                    raster.document.sourcePdfPath === sourcePdfPath
                    && raster.document.documentRevision === documentRevision
                ) {
                    if (raster.document.pinned === 0) {
                        forget(key, raster);
                        rasterClaims.delete(key);
                        removeRaster(raster);
                    }
                }
            }
            if (matchingDocument?.pinned === 0) {
                discard(matchingDocument);
            }
        },
        async dispose() {
            disposed = true;
            for (const document of [...documents.values()]) discard(document, true);
            documents.clear();
            const pendingOpenings = [...opening.values()];
            opening.clear();
            await Promise.all(pendingOpenings).catch(() => undefined);
            await readLifecycle.settled;
            await enqueuePathOperation.drain();
            await Promise.all([...pendingPathCleanups]);
            await enqueuePathOperation.drain();
            inFlightReads.clear();
            pendingRasterReleases.clear();
            rasterClaims.clear();
            activeClaimOperations.clear();
            canceledClaims.clear();
            await Promise.all([...pendingStoreClosures]);
            rasters.clear();
            adoptedRasters.clear();
            retainedBytes = 0;
            const rootPath = await root?.catch(() => null);
            if (rootPath !== null && rootPath !== undefined) {
                await fileSystem.rm(rootPath, {
                    recursive: true,
                    force: true,
                });
            }
            root = null;
            budget = null;
        },
    };
}
