import type {
    Component,
    ComputedRef,
    Ref,
} from 'vue';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    TPdfViewRotation,
    TPdfViewMode,
    TPdfZoomState,
    TPrintOrientation,
} from '@contracts/shared';
import {
    requireJobId,
    createRequestId,
} from '@contracts/shared';
import type { IAnnotationInventoryCompleteness } from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdfUi';
import type {
    IAnnotationCreationFailureReport,
    IDocumentViewerExpose,
    IPdfViewerExpose,
} from '@app/modules/pdf-viewer/public';
import {isPathPdfSource} from '@app/modules/pdf-viewer/public';
import type { TPdfRasterDisplayProfile } from '@app/types/pdfRasterDisplayProfile';
import type {TDocumentImageExportSourceKind} from '@contracts/imageExportPlatformFeature';
import type {
    IWorkspaceViewerCapabilities,
    TDocumentCommitReceipt,
} from '@app/types/workspaceExpose';
import {
    getWorkspaceViewerAdapter,
    resolveWorkspaceViewerViewMode,
    resolveWorkspaceViewerAdapter,
} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type {
    IWorkspaceViewerAdapter,
    IWorkspaceViewerLifecycleContext,
    IWorkspaceViewerLifecycleHooks,
    TWorkspaceDocumentDriverId,
} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';
import type {
    IDocumentPageSource,
    IDocumentSourceCapabilities, IDocumentSearchMatch, 
} from '@app/modules/document-viewer/public';
import { getDocumentKindFromPath } from '@app/utils/supportedDocumentPaths';
import { getDjvuCapability } from '@app/utils/getDjvuCapability';
import {
    createDocumentProjectionSession,
    ensurePdfProjection,
} from '@app/modules/document-viewer/public';

export type {TWorkspaceDocumentDriverId} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

/**
 * Handler for the viewer's annotation-inventory event.
 *
 * The viewer reports `null` while an inventory is still pending and a
 * completeness record once a pass finishes, so the workspace can tell
 * "not measured yet" from "measured and partial". Typing the handler here is
 * what keeps that distinction: the listener map this feeds is an untyped bag
 * of `v-on` entries, so an `unknown` handler would let a payload of any shape
 * reach `applyAnnotationInventory` and surface as a wrong completeness notice
 * rather than a compile error.
 */
export type TAnnotationInventoryListener = (
    completeness: IAnnotationInventoryCompleteness | null,
) => void;

interface IActiveViewerListeners extends Record<string, unknown> {
    annotationInventory?: TAnnotationInventoryListener;
}

const PDF_SOURCE_CAPABILITIES: IDocumentSourceCapabilities = {
    annotations: true,
    directImageExport: true,
    outline: true,
    pageEdits: true,
    search: true,
    text: true,
};

export interface IWorkspaceDocumentDriverSource {
    kind: 'pdf' | 'djvu';
    path: TDocumentRef | null;
}

export type TWorkspaceDocumentSaveStrategy = 'pdf-working-copy' | 'djvu-pdf-projection';
export type TWorkspaceDocumentSaveAction = 'save' | 'save-as';
export type TWorkspaceDocumentPrintStrategy = 'pdf' | 'djvu-pdf-projection';

export interface IWorkspaceDocumentDriverExportTarget {
    sourceKind: TDocumentImageExportSourceKind;
    sourcePath: TDocumentRef;
    requiresFreshWorkingCopy: boolean;
}

export interface IWorkspaceDocumentDriverOperations {
    save: {
        strategy: TWorkspaceDocumentSaveStrategy;
        execute: (action: TWorkspaceDocumentSaveAction, onCommitted?: TDocumentCommitReceipt) => Promise<boolean>;
    };
    export: {
        imageTarget: IWorkspaceDocumentDriverExportTarget | null;
        multiPageTiffTarget: IWorkspaceDocumentDriverExportTarget | null;
    };
    print: {
        strategy: TWorkspaceDocumentPrintStrategy | null;
        path: TDocumentRef | null;
    };
}

export interface IWorkspaceDocumentDriverLifecycle {createHooks: (context: IWorkspaceViewerLifecycleContext) => IWorkspaceViewerLifecycleHooks | null;}

export interface IWorkspaceDocumentDriverView {
    component: Component;
    isPdfjs: boolean;
    rendererKind: 'pdfjs' | 'page-source';
    sourceKind: 'pdf' | 'djvu';
    sourcePath: TDocumentRef | null;
    defaultSourceCapabilities: IDocumentSourceCapabilities | null;
    showDjvuSource: boolean;
    showPdfSidebar: boolean;
    startupVisualSource: 'djvu-src' | null;
}

export interface IWorkspaceDriverPrintRequest {
    pageNumbers?: number[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}

export interface IWorkspaceDriverCommand {
    kind: 'prepare-print';
    request: IWorkspaceDriverPrintRequest;
    fileName: string | null;
    sourceCapabilities: IDocumentSourceCapabilities;
    onNativePrintHandoffStart?: () => void;
    signal?: AbortSignal;
}

export type TWorkspaceDriverCommandResult =
    | {status: 'completed'}
    | {
        // A platform without a print dialog of its own prepared this PDF; the
        // workspace prints it, then releases it.
        status: 'printable-pdf';
        documentRef: TDocumentRef;
        release(): Promise<void>;
    }
    | {
        status: 'unavailable';
        capability: keyof IWorkspaceViewerCapabilities;
    };

export interface IWorkspaceDocumentDriver {
    readonly id: TWorkspaceDocumentDriverId;
    readonly capabilities: Readonly<IWorkspaceViewerCapabilities>;
    readonly canPreparePrint: boolean;
    readonly lifecycle: IWorkspaceDocumentDriverLifecycle;
    readonly operations: IWorkspaceDocumentDriverOperations;
    readonly source: IWorkspaceDocumentDriverSource;
    readonly view: IWorkspaceDocumentDriverView;
    run(command: IWorkspaceDriverCommand): Promise<TWorkspaceDriverCommandResult>;
}

interface IWorkspaceDocumentDriverSources {
    djvuSourcePath: Ref<TDocumentRef | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    save?: {
        save: (onCommitted?: TDocumentCommitReceipt) => Promise<boolean>;
        saveAs: () => Promise<boolean>;
        saveAsDjvuProjection: () => Promise<boolean>;
    };
}

export interface IWorkspaceDocumentDriverOptions {
    djvuSourcePath: Ref<TDocumentRef | null>;
    isDjvuMode: Ref<boolean>;
    pdfSrc: Ref<TPdfSource | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    pendingDocumentPath?: TReadableRef<TDocumentRef | null>;
    pendingDocumentSize?: TReadableRef<number | null>;
    save?: IWorkspaceDocumentDriverSources['save'];
}

function createDriverPrintRequestId() {
    return createRequestId('djvu-print');
}

function createDriverPrintAbortError() {
    const error = new Error('Print preparation was canceled');
    error.name = 'AbortError';
    return error;
}

function throwIfDriverPrintAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw createDriverPrintAbortError();
    }
}

function createPrintProjectionSource(kind: 'pdf' | 'djvu', documentRef: TDocumentRef): IDocumentPageSource {
    const unavailable = () => Promise.reject(new Error('Print projection source cannot render pages'));
    return {
        kind,
        documentRef,
        pageCount: 0,
        getPageMetrics: unavailable,
        renderPage: unavailable,
        dispose() {},
    };
}

function runUnavailableDriverCommand(): Promise<TWorkspaceDriverCommandResult> {
    return Promise.resolve({
        status: 'unavailable',
        capability: 'print',
    });
}

async function prepareDjvuPrint(
    sources: IWorkspaceDocumentDriverSources,
    command: IWorkspaceDriverCommand,
): Promise<TWorkspaceDriverCommandResult> {
    const sourcePath = sources.djvuSourcePath.value;
    if (!sourcePath) {
        return {
            status: 'unavailable',
            capability: 'print',
        };
    }
    const requestId = createDriverPrintRequestId();
    const jobId = requireJobId(`djvu-print-${requestId}`);
    const cancelPrint = () => {
        void getDjvuCapability().cancel(jobId).catch(() => undefined);
    };
    throwIfDriverPrintAborted(command.signal);
    command.signal?.addEventListener('abort', cancelPrint, { once: true });
    let printablePdfPath: TDocumentRef | null = null;
    try {
        const printSession = createDocumentProjectionSession({
            id: `${String(sourcePath)}:${requestId}`,
            originalRef: sourcePath,
            source: createPrintProjectionSource('djvu', sourcePath),
            capabilities: command.sourceCapabilities,
        });
        await ensurePdfProjection(printSession, {build: async () => {
            const {
                pageNumbers,
                ...printRequest
            } = command.request;
            const result = await getDjvuCapability().printDjvuPath(sourcePath, {
                ...printRequest,
                ...(pageNumbers === undefined
                    ? {}
                    : {pageNumbers: pageNumbers.map(pageNumber => requirePageNumber(pageNumber))}),
                requestId,
                pdfStrategy: 'compact-djvu-aware',
                ...(command.fileName ? { fileName: command.fileName } : {}),
            });
            printablePdfPath = result.printablePdfPath ?? null;
            if (command.signal?.aborted || result.canceled) {
                throw createDriverPrintAbortError();
            }
            if (!result.success) {
                throw new Error(result.error ?? 'DjVu print preparation failed');
            }
            const outputState = await getDjvuCapability().getJobState(result.jobId ?? jobId);
            if (
                outputState?.operation !== 'djvu-print'
                || (outputState.status !== 'handoff' && outputState.status !== 'completed')
                || !('artifactPath' in outputState)
                || !outputState.artifactPath
            ) {
                throw new Error('DjVu print completed without an accepted output-service handoff');
            }
            return {
                documentRef: outputState.artifactPath,
                source: createPrintProjectionSource('pdf', outputState.artifactPath),
                capabilities: PDF_SOURCE_CAPABILITIES,
            };
        }}, 'print', command.signal);
        if (printablePdfPath) {
            const documentRef = printablePdfPath;
            return {
                status: 'printable-pdf',
                documentRef,
                release: () => getDjvuCapability().cleanupTemp(documentRef),
            };
        }
        command.onNativePrintHandoffStart?.();
        return {status: 'completed'};
    } catch (error) {
        // A print that ends here, a late cancel included, keeps nothing it prepared.
        if (printablePdfPath) await getDjvuCapability().cleanupTemp(printablePdfPath).catch(() => undefined);
        throw error;
    } finally {
        command.signal?.removeEventListener('abort', cancelPrint);
    }
}

export function createWorkspaceDocumentDriverForAdapter(
    adapter: IWorkspaceViewerAdapter,
    sources: IWorkspaceDocumentDriverSources,
): IWorkspaceDocumentDriver {
    const {driverProfile} = adapter;
    const {isDjvu} = driverProfile;
    return {
        id: driverProfile.id,
        capabilities: adapter.capabilities,
        get canPreparePrint() {
            return isDjvu && sources.djvuSourcePath.value !== null;
        },
        lifecycle: {createHooks: context => adapter.createLifecycleHooks?.(context) ?? null},
        get operations(): IWorkspaceDocumentDriverOperations {
            const sourcePath = isDjvu
                ? sources.djvuSourcePath.value
                : sources.workingCopyPath.value;
            const imageTarget = sourcePath === null
                ? null
                : {
                    sourceKind: isDjvu ? 'djvu' : 'pdf',
                    sourcePath,
                    requiresFreshWorkingCopy: !isDjvu,
                } satisfies IWorkspaceDocumentDriverExportTarget;
            const multiPageTiffTarget = imageTarget === null
                ? null
                : {...imageTarget};
            const printPath = isDjvu ? null : sourcePath;
            return {
                save: {
                    strategy: isDjvu ? 'djvu-pdf-projection' : 'pdf-working-copy',
                    execute: (action, onCommitted) => {
                        if (isDjvu && action === 'save-as') {
                            return sources.save?.saveAsDjvuProjection() ?? Promise.resolve(false);
                        }
                        return action === 'save'
                            ? sources.save?.save(onCommitted) ?? Promise.resolve(false)
                            : sources.save?.saveAs() ?? Promise.resolve(false);
                    },
                },
                export: {
                    imageTarget,
                    multiPageTiffTarget,
                },
                print: {
                    strategy: isDjvu ? 'djvu-pdf-projection' : 'pdf',
                    path: printPath,
                },
            };
        },
        get source(): IWorkspaceDocumentDriverSource {
            return {
                kind: isDjvu ? 'djvu' : 'pdf',
                path: isDjvu
                    ? sources.djvuSourcePath.value
                    : sources.workingCopyPath.value,
            };
        },
        get view(): IWorkspaceDocumentDriverView {
            return {
                component: adapter.component,
                isPdfjs: driverProfile.isPdfjs,
                rendererKind: driverProfile.rendererKind,
                sourceKind: driverProfile.sourceKind,
                sourcePath: isDjvu ? sources.djvuSourcePath.value : null,
                defaultSourceCapabilities: isDjvu ? null : PDF_SOURCE_CAPABILITIES,
                showDjvuSource: isDjvu,
                showPdfSidebar: !isDjvu,
                startupVisualSource: isDjvu ? 'djvu-src' : null,
            };
        },
        run: isDjvu
            ? command => prepareDjvuPrint(sources, command)
            : runUnavailableDriverCommand,
    };
}

export const useWorkspaceDocumentDriver = (
    options: IWorkspaceDocumentDriverOptions,
) => {
    const pendingDocumentKind = computed(() => getDocumentKindFromPath(options.pendingDocumentPath?.value ?? ''));
    const sources = {
        djvuSourcePath: options.djvuSourcePath,
        workingCopyPath: options.workingCopyPath,
        save: options.save ?? {
            save: async () => {
                await Promise.resolve();
                return false;
            },
            saveAs: async () => {
                await Promise.resolve();
                return false;
            },
            saveAsDjvuProjection: async () => {
                await Promise.resolve();
                return false;
            },
        },
    };
    const drivers = {
        djvu: createWorkspaceDocumentDriverForAdapter(getWorkspaceViewerAdapter('djvu'), sources),
        pdfjs: createWorkspaceDocumentDriverForAdapter(getWorkspaceViewerAdapter('pdf'), sources),
    };
    const driverList = [
        drivers.djvu,
        drivers.pdfjs,
    ] as const;
    const activeDocumentDriver = computed(() => {
        const adapter = resolveWorkspaceViewerAdapter({
            djvuSourcePath: options.djvuSourcePath.value
                ?? (pendingDocumentKind.value === 'djvu' ? options.pendingDocumentPath?.value ?? null : null),
            isDjvuMode: options.isDjvuMode.value || pendingDocumentKind.value === 'djvu',
            pdfSourcePath: isPathPdfSource(options.pdfSrc.value)
                ? options.pdfSrc.value.path
                : options.pdfSrc.value
                    ? parseDocumentRef('browser://documents/in-memory-pdf')
                    : pendingDocumentKind.value === 'pdf'
                        ? options.pendingDocumentPath?.value ?? null
                        : null,
        });
        return adapter
            ? driverList.find(driver => driver.id === adapter.driverProfile.id) ?? null
            : null;
    });

    return {
        activeDocumentDriver,
        handleSave: (onCommitted?: TDocumentCommitReceipt) => (
            activeDocumentDriver.value?.operations.save.execute('save', onCommitted) ?? Promise.resolve(false)
        ),
        handleSaveAs: () => activeDocumentDriver.value?.operations.save.execute('save-as') ?? Promise.resolve(false),
        mountedDocumentDriver: computed(() => activeDocumentDriver.value ?? drivers.pdfjs),
        createLifecycleHooks: (context: IWorkspaceViewerLifecycleContext) => driverList.flatMap((driver) => {
            const hooks = driver.lifecycle.createHooks(context);
            return hooks ? [hooks] : [];
        }),
    };
};

export interface IWorkspaceDocumentDriverBindingOptions {
    activeDocumentDriver: ComputedRef<IWorkspaceDocumentDriver>;
    annotationCursorMode: TReadableRef<unknown>;
    annotationKeepActive: TReadableRef<unknown>;
    annotationSettings: TReadableRef<unknown>;
    annotationTool: Ref<unknown>;
    authorName: TReadableRef<string>;
    continuousScroll: Ref<boolean>;
    currentResultNavigationId: Ref<number>;
    currentSearchMatch: TReadableRef<unknown>;
    documentSourceCurrentResultIndex: TReadableRef<number>;
    documentSourceSearchResults: TReadableRef<readonly IDocumentSearchMatch[]>;
    dragMode: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    isInteractionActive: TReadableRef<boolean>;
    mountPresentation: TReadableRef<boolean>;
    isRenderActive: TReadableRef<boolean>;
    isWorkspaceLayoutResizing: TReadableRef<boolean>;
    pageMatches: TReadableRef<unknown>;
    pdfRasterDisplayProfile: TReadableRef<TPdfRasterDisplayProfile | null>;
    pdfSrc: Ref<TPdfSource | null>;
    pendingDocumentPath?: TReadableRef<TDocumentRef | null>;
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    djvuViewerRef: Ref<IDocumentViewerExpose | null>;
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
    sourcePdfData: TReadableRef<Uint8Array | null>;
    viewMode: Ref<TPdfViewMode>;
    viewRotation: Ref<TPdfViewRotation>;
    workingCopyPath: Ref<TDocumentRef | null>;
    originalPath: Ref<TDocumentRef | null>;
    zoomState: Ref<TPdfZoomState>;
    onAnnotationCommentClick: unknown;
    onAnnotationComments: unknown;
    onAnnotationInventory: TAnnotationInventoryListener;
    onAnnotationContextMenu: unknown;
    onAnnotationModified: unknown;
    onAnnotationFailure: (failure: IAnnotationCreationFailureReport) => void;
    onAnnotationOpenNote: unknown;
    onAnnotationSetting: unknown;
    onAnnotationState: unknown;
    onAnnotationToolAutoReset: () => void;
    onAnnotationToolCancel: () => void;
    onDocumentUpdate: (value: unknown) => void;

    onInitialVisualPending: () => void;
    onInitialVisualReady: () => void;
    onLoadError: (error: unknown) => void;
    onLoading: (value: boolean) => void;
    onShapeContextMenu: unknown;
    onSourceCapabilitiesUpdate: (capabilities: IDocumentSourceCapabilities) => void;
    onPageSourceUpdate: (source: IDocumentPageSource | null) => void;
    onTotalPagesUpdate: (value: number) => void;
    onZoomStateUpdate: (value: TPdfZoomState) => void;
}

export const useWorkspaceDocumentDriverBinding = (options: IWorkspaceDocumentDriverBindingOptions) => {
    function setViewerRef<T>(target: Ref<T | null>, value: T | null) {
        if (target.value !== value) {
            target.value = value;
        }
    }

    function createViewerProps(source: TPdfSource | TDocumentRef | null) {
        return {
            src: source,
            zoomState: options.zoomState.value,
            viewMode: resolveWorkspaceViewerViewMode(
                options.activeDocumentDriver.value.capabilities,
                options.viewMode.value,
            ),
            continuousScroll: options.continuousScroll.value,
            dragMode: options.dragMode.value,
            documentRevisionToken: options.documentRevisionToken.value,
            isActive: options.isRenderActive.value,
            mountPresentation: options.mountPresentation.value,
            isInteractionActive: options.isInteractionActive.value,
        };
    }

    const activeViewerProps = computed<Record<string, unknown>>(() => {
        const driver = options.activeDocumentDriver.value;
        if (driver.view.isPdfjs) {
            return {
                sourceKind: 'pdf',
                rendererKind: 'pdfjs',
                ...createViewerProps(options.pdfSrc.value),
                rasterDisplayProfile: options.pdfRasterDisplayProfile.value,
                sourcePdfData: options.sourcePdfData.value,
                isAnySaving: options.isAnySaving.value,
                viewRotation: options.viewRotation.value,
                isResizing: options.isWorkspaceLayoutResizing.value,
                annotationTool: options.annotationTool.value,
                annotationCursorMode: options.annotationCursorMode.value,
                annotationKeepActive: options.annotationKeepActive.value,
                annotationSettings: options.annotationSettings.value,
                searchPageMatches: options.pageMatches.value,
                currentSearchMatch: options.currentSearchMatch.value,
                currentSearchMatchNavigationId: options.currentResultNavigationId.value,
                workingCopyPath: options.workingCopyPath.value,
                originalPath: options.originalPath.value ?? options.pendingDocumentPath?.value ?? null,
                authorName: options.authorName.value,
                // Temporary direct command seam. #193 removes the legacy
                // workspace stamp persistence route after writer ownership is
                // complete.
            };
        }

        const nativeProps = createViewerProps(driver.view.sourcePath);
        return {
            ...nativeProps,
            sourceKind: driver.view.sourceKind,
            rendererKind: driver.view.rendererKind,
            ...(driver.view.showDjvuSource
                ? {
                    isResizing: options.isWorkspaceLayoutResizing.value,
                    searchResults: options.documentSourceSearchResults.value,
                    currentSearchResultIndex: options.documentSourceCurrentResultIndex.value,
                }
                : {}),
        };
    });

    const activeViewerComponent = computed(() => options.activeDocumentDriver.value.view.component);

    const nativeViewerListeners = {
        'update:zoomState': options.onZoomStateUpdate,
        'update:totalPages': options.onTotalPagesUpdate,
        'update:document': options.onDocumentUpdate,
        loading: options.onLoading,
        loadError: options.onLoadError,
        initialVisualPending: options.onInitialVisualPending,
        initialVisualReady: options.onInitialVisualReady,
        'update:sourceCapabilities': options.onSourceCapabilitiesUpdate,
        'update:pageSource': options.onPageSourceUpdate,
    };

    const activeViewerListeners = computed<IActiveViewerListeners>(() => {
        if (!options.activeDocumentDriver.value.view.isPdfjs) {
            return nativeViewerListeners;
        }

        return {
            ...nativeViewerListeners,
            annotationState: options.onAnnotationState,
            annotationModified: options.onAnnotationModified,
            annotationComments: options.onAnnotationComments,
            annotationInventory: options.onAnnotationInventory,
            annotationOpenNote: options.onAnnotationOpenNote,
            annotationCommentClick: options.onAnnotationCommentClick,
            annotationContextMenu: options.onAnnotationContextMenu,
            annotationToolAutoReset: options.onAnnotationToolAutoReset,
            annotationToolCancel: options.onAnnotationToolCancel,
            annotationSetting: options.onAnnotationSetting,
            annotationFailure: options.onAnnotationFailure,
            shapeContextMenu: options.onShapeContextMenu,
        };
    });

    function bindActiveViewerRef(instance: unknown) {
        const driverView = options.activeDocumentDriver.value.view;
        setViewerRef(
            options.pdfViewerRef,
            driverView.isPdfjs && instance
                ? instance as IPdfViewerExpose
                : null,
        );
        setViewerRef(
            options.djvuViewerRef,
            driverView.showDjvuSource && instance
                ? instance as IDocumentViewerExpose
                : null,
        );
    }

    return {
        activeViewerComponent,
        activeViewerProps,
        activeViewerListeners,
        bindActiveViewerRef,
    };
};
