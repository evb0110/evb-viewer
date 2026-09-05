import type {
    IWorkspaceAgentPort,
    IWorkspaceAutomationPort,
    IWorkspaceExportPort,
    IWorkspaceExpose,
    IWorkspaceFilePort,
    IWorkspacePageOpsPort,
    IWorkspaceSplitTransferPort,
    IWorkspaceUiPort,
    IWorkspaceViewPort,
} from '@app/types/workspaceExpose';
import type { IDocumentsMenuCapability } from '@contracts/electronApiDocuments';
import type { IDjvuCapability } from '@contracts/djvuPlatformFeature';
import type { TPdfViewMode } from '@contracts/shared';

export type TWorkspaceExposeMethod = keyof Omit<IWorkspaceExpose, 'hasPdf'>;
export type TWorkspaceExposeCommandHandler<TName extends TWorkspaceExposeMethod> =
    NonNullable<IWorkspaceExpose[TName]> extends (...args: infer TArgs) => infer TResult
        ? (...args: TArgs) => TResult
        : never;
export type TWorkspaceExposeCommandHandlerMap = {
    [TName in TWorkspaceExposeMethod]-?: TWorkspaceExposeCommandHandler<TName>;
};
export type TWorkspaceExposeCommandRunner = (...args: unknown[]) => unknown;

type TWorkspaceExposeCommandGroup = keyof IWorkspaceExposeMethodDescriptorMap;
type TWorkspaceExposeCommandKind = 'async' | 'sync';
type TWorkspaceRealCommandStrategy = 'passthrough' | 'custom';
type TWorkspaceDeferredCommandStrategy =
    | 'mountWaitBoolean'
    | 'mountWaitVoid'
    | 'mountWaitSyncVoid'
    | 'directBoolean'
    | 'custom';

interface IWorkspaceDocumentMenuCommandDescriptor {
    readonly actionName: string;
    readonly source?: 'documentMenu' | 'djvu';
    readonly register: keyof IDocumentsMenuCapability | keyof IDjvuCapability;
}

interface IWorkspaceToolbarCommandDescriptor {readonly eventName: string;}

interface IWorkspaceExposeCommandDescriptorBase {
    readonly name: TWorkspaceExposeMethod;
    readonly group: TWorkspaceExposeCommandGroup;
    readonly kind: TWorkspaceExposeCommandKind;
    readonly real: TWorkspaceRealCommandStrategy;
    readonly deferred: TWorkspaceDeferredCommandStrategy;
    readonly menu?: IWorkspaceDocumentMenuCommandDescriptor;
    readonly toolbar?: IWorkspaceToolbarCommandDescriptor;
}

export class WorkspaceExposeCommandUnavailableError extends Error {
    readonly commandName: TWorkspaceExposeMethod;

    constructor(commandName: TWorkspaceExposeMethod) {
        super(`Workspace command is unavailable before mount: ${commandName}`);
        this.name = 'WorkspaceExposeCommandUnavailableError';
        this.commandName = commandName;
    }
}

interface IWorkspaceExposeMethodDescriptorMap {
    readonly file: ReadonlyArray<keyof IWorkspaceFilePort>;
    readonly export: ReadonlyArray<keyof IWorkspaceExportPort>;
    readonly view: ReadonlyArray<keyof IWorkspaceViewPort>;
    readonly pageOps: ReadonlyArray<keyof IWorkspacePageOpsPort>;
    readonly splitTransfer: ReadonlyArray<keyof IWorkspaceSplitTransferPort>;
    readonly ui: ReadonlyArray<keyof IWorkspaceUiPort>;
    readonly agent: ReadonlyArray<keyof IWorkspaceAgentPort>;
    readonly automation: ReadonlyArray<keyof IWorkspaceAutomationPort>;
}

function defineWorkspaceExposeCommandRegistry<const TRegistry extends readonly IWorkspaceExposeCommandDescriptorBase[]>(
    registry: TRegistry,
) {
    return registry;
}

export const workspaceExposeCommandRegistry = defineWorkspaceExposeCommandRegistry([
    {
        name: 'handleSave',
        kind: 'async',
        toolbar: {eventName: 'save'},
        group: 'file',
        real: 'custom',
        deferred: 'mountWaitBoolean',
        menu: {
            actionName: 'save',
            register: 'onMenuSave',
        },
    },
    {
        name: 'handleRepairSave',
        kind: 'async',
        toolbar: {eventName: 'repair-save'},
        group: 'file',
        real: 'custom',
        deferred: 'mountWaitBoolean',
        menu: {
            actionName: 'repair-save',
            register: 'onMenuRepairSave',
        },
    },
    {
        name: 'handleOptimizePdfForInteraction',
        kind: 'async',
        toolbar: {eventName: 'optimize-pdf-for-interaction'},
        group: 'file',
        real: 'custom',
        deferred: 'mountWaitBoolean',
        menu: {
            actionName: 'optimize-pdf-for-interaction',
            register: 'onMenuOptimizePdfForInteraction',
        },
    },
    {
        name: 'handleSaveAs',
        kind: 'async',
        toolbar: {eventName: 'save-as'},
        group: 'file',
        real: 'passthrough',
        deferred: 'mountWaitBoolean',
        menu: {
            actionName: 'save-as',
            register: 'onMenuSaveAs',
        },
    },
    {
        name: 'handlePrint',
        kind: 'async',
        toolbar: {eventName: 'print'},
        group: 'file',
        real: 'passthrough',
        deferred: 'mountWaitVoid',
        menu: {
            actionName: 'print',
            register: 'onMenuPrint',
        },
    },
    {
        name: 'handlePrintCurrentPage',
        kind: 'async',
        toolbar: {eventName: 'print-current-page'},
        group: 'file',
        real: 'passthrough',
        deferred: 'mountWaitVoid',
        menu: {
            actionName: 'print-current-page',
            register: 'onMenuPrintCurrentPage',
        },
    },
    {
        name: 'handleUndo',
        kind: 'sync',
        toolbar: {eventName: 'undo'},
        group: 'file',
        real: 'passthrough',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'undo',
            register: 'onMenuUndo',
        },
    },
    {
        name: 'handleRedo',
        kind: 'sync',
        toolbar: {eventName: 'redo'},
        group: 'file',
        real: 'passthrough',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'redo',
            register: 'onMenuRedo',
        },
    },
    {
        name: 'handleOpenFileFromUi',
        kind: 'async',
        group: 'file',
        real: 'passthrough',
        deferred: 'custom',
    },
    {
        name: 'handleCombineImages',
        kind: 'async',
        group: 'file',
        real: 'passthrough',
        deferred: 'directBoolean',
    },
    {
        name: 'handleOpenFileDirectWithPersist',
        kind: 'async',
        group: 'file',
        real: 'passthrough',
        deferred: 'custom',
    },
    {
        name: 'handleOpenFileDirectBatchWithPersist',
        kind: 'async',
        group: 'file',
        real: 'passthrough',
        deferred: 'custom',
    },
    {
        name: 'handleOpenFileWithResult',
        kind: 'async',
        group: 'file',
        real: 'passthrough',
        deferred: 'custom',
    },
    {
        name: 'handleCloseFileFromUi',
        kind: 'async',
        group: 'file',
        real: 'passthrough',
        deferred: 'mountWaitBoolean',
    },
    {
        name: 'handleExportDocx',
        kind: 'async',
        toolbar: {eventName: 'export-docx'},
        group: 'export',
        real: 'passthrough',
        deferred: 'mountWaitVoid',
        menu: {
            actionName: 'export-docx',
            register: 'onMenuExportDocx',
        },
    },
    {
        name: 'handleExportImages',
        kind: 'async',
        toolbar: {eventName: 'export-images'},
        group: 'export',
        real: 'passthrough',
        deferred: 'mountWaitVoid',
        menu: {
            actionName: 'export-images',
            register: 'onMenuExportImages',
        },
    },
    {
        name: 'handleExportMultiPageTiff',
        kind: 'async',
        toolbar: {eventName: 'export-multi-page-tiff'},
        group: 'export',
        real: 'passthrough',
        deferred: 'mountWaitVoid',
        menu: {
            actionName: 'export-multi-page-tiff',
            register: 'onMenuExportMultiPageTiff',
        },
    },
    {
        name: 'handleZoomIn',
        kind: 'sync',
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'zoom-in',
            register: 'onMenuZoomIn',
        },
    },
    {
        name: 'handleZoomOut',
        kind: 'sync',
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'zoom-out',
            register: 'onMenuZoomOut',
        },
    },
    {
        name: 'handleFitWidth',
        kind: 'sync',
        toolbar: {eventName: 'fit-width'},
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'fit-width',
            register: 'onMenuFitWidth',
        },
    },
    {
        name: 'handleFitHeight',
        kind: 'sync',
        toolbar: {eventName: 'fit-height'},
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'fit-height',
            register: 'onMenuFitHeight',
        },
    },
    {
        name: 'handleActualSize',
        kind: 'sync',
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'actual-size',
            register: 'onMenuActualSize',
        },
    },
    {
        name: 'setCustomZoomFromDisplay',
        kind: 'sync',
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
    },
    {
        name: 'handleGoToPage',
        kind: 'sync',
        toolbar: {eventName: 'go-to-page'},
        group: 'view',
        real: 'passthrough',
        deferred: 'mountWaitSyncVoid',
    },
    {
        name: 'handleToggleSidebar',
        kind: 'sync',
        toolbar: {eventName: 'toggle-sidebar'},
        group: 'view',
        real: 'passthrough',
        deferred: 'mountWaitSyncVoid',
    },
    {
        name: 'handleToggleContinuousScroll',
        kind: 'sync',
        toolbar: {eventName: 'toggle-continuous-scroll'},
        group: 'view',
        real: 'passthrough',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'toggle-continuous-scroll',
            register: 'onMenuToggleContinuousScroll',
        },
    },
    {
        name: 'handleEnableDragMode',
        kind: 'sync',
        toolbar: {eventName: 'enable-drag'},
        group: 'view',
        real: 'passthrough',
        deferred: 'mountWaitSyncVoid',
    },
    {
        name: 'handleDisableDragMode',
        kind: 'sync',
        toolbar: {eventName: 'disable-drag'},
        group: 'view',
        real: 'passthrough',
        deferred: 'mountWaitSyncVoid',
    },
    {
        name: 'handleCaptureRegion',
        kind: 'sync',
        toolbar: {eventName: 'capture-region'},
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
    },
    {
        name: 'handleCrop',
        kind: 'sync',
        toolbar: {eventName: 'crop'},
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
    },
    {
        name: 'handleQuickNote',
        kind: 'sync',
        toolbar: {eventName: 'quick-note'},
        group: 'view',
        real: 'passthrough',
        deferred: 'mountWaitSyncVoid',
    },
    {
        name: 'handleInsertImageFromFile',
        kind: 'async',
        toolbar: {eventName: 'insert-image-from-file'},
        group: 'view',
        real: 'passthrough',
        deferred: 'mountWaitVoid',
        menu: {
            actionName: 'insert-image-from-file',
            register: 'onMenuInsertImageFromFile',
        },
    },
    {
        name: 'handlePasteImageFromClipboard',
        kind: 'async',
        toolbar: {eventName: 'paste-image-from-clipboard'},
        group: 'view',
        real: 'passthrough',
        deferred: 'mountWaitBoolean',
        menu: {
            actionName: 'paste-image-from-clipboard',
            register: 'onMenuPasteImageFromClipboard',
        },
    },
    {
        name: 'handleViewModeSingle',
        kind: 'sync',
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'view-mode-single',
            register: 'onMenuViewModeSingle',
        },
    },
    {
        name: 'handleViewModeFacing',
        kind: 'sync',
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'view-mode-facing',
            register: 'onMenuViewModeFacing',
        },
    },
    {
        name: 'handleViewModeFacingFirstSingle',
        kind: 'sync',
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'view-mode-facing-first-single',
            register: 'onMenuViewModeFacingFirstSingle',
        },
    },
    {
        name: 'handleViewRotationCw',
        kind: 'sync',
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'view-rotation-cw',
            register: 'onMenuViewRotationCw',
        },
    },
    {
        name: 'handleViewRotationCcw',
        kind: 'sync',
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'view-rotation-ccw',
            register: 'onMenuViewRotationCcw',
        },
    },
    {
        name: 'setViewRotation',
        kind: 'sync',
        group: 'view',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
    },
    {
        name: 'handleDeletePages',
        kind: 'sync',
        toolbar: {eventName: 'delete-pages'},
        group: 'pageOps',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'delete-pages',
            register: 'onMenuDeletePages',
        },
    },
    {
        name: 'handleExtractPages',
        kind: 'sync',
        toolbar: {eventName: 'extract-pages'},
        group: 'pageOps',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'extract-pages',
            register: 'onMenuExtractPages',
        },
    },
    {
        name: 'handleRotateCw',
        kind: 'sync',
        toolbar: {eventName: 'rotate-cw'},
        group: 'pageOps',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'rotate-cw',
            register: 'onMenuRotateCw',
        },
    },
    {
        name: 'handleRotateCcw',
        kind: 'sync',
        toolbar: {eventName: 'rotate-ccw'},
        group: 'pageOps',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'rotate-ccw',
            register: 'onMenuRotateCcw',
        },
    },
    {
        name: 'handleInsertPages',
        kind: 'sync',
        toolbar: {eventName: 'insert-pages'},
        group: 'pageOps',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'insert-pages',
            register: 'onMenuInsertPages',
        },
    },
    {
        name: 'pageOpsReorder',
        kind: 'async',
        group: 'pageOps',
        real: 'passthrough',
        deferred: 'mountWaitBoolean',
    },
    {
        name: 'handlePageDelete',
        kind: 'async',
        group: 'pageOps',
        real: 'passthrough',
        deferred: 'mountWaitVoid',
    },
    {
        name: 'handlePageReorder',
        kind: 'async',
        group: 'pageOps',
        real: 'passthrough',
        deferred: 'mountWaitVoid',
    },
    {
        name: 'handlePageMove',
        kind: 'async',
        group: 'pageOps',
        real: 'passthrough',
        deferred: 'mountWaitVoid',
    },
    {
        name: 'pageOpsDelete',
        kind: 'async',
        group: 'pageOps',
        real: 'passthrough',
        deferred: 'mountWaitBoolean',
    },
    {
        name: 'handlePageRotate',
        kind: 'async',
        group: 'pageOps',
        real: 'passthrough',
        deferred: 'mountWaitBoolean',
    },
    {
        name: 'pageOpsInsert',
        kind: 'async',
        group: 'pageOps',
        real: 'passthrough',
        deferred: 'mountWaitBoolean',
    },
    {
        name: 'pageOpsMove',
        kind: 'async',
        group: 'pageOps',
        real: 'passthrough',
        deferred: 'mountWaitBoolean',
    },
    {
        name: 'handleCropPages',
        kind: 'async',
        group: 'pageOps',
        real: 'passthrough',
        deferred: 'mountWaitBoolean',
    },
    {
        name: 'handleConvertToPdf',
        kind: 'sync',
        toolbar: {eventName: 'convert-to-pdf'},
        group: 'pageOps',
        real: 'custom',
        deferred: 'mountWaitSyncVoid',
        menu: {
            actionName: 'convert-to-pdf',
            source: 'djvu',
            register: 'onMenuConvertToPdf',
        },
    },
    {
        name: 'captureSplitPayload',
        kind: 'async',
        group: 'splitTransfer',
        real: 'passthrough',
        deferred: 'custom',
    },
    {
        name: 'restoreSplitPayload',
        kind: 'async',
        group: 'splitTransfer',
        real: 'passthrough',
        deferred: 'custom',
    },
    {
        name: 'closeAllDropdowns',
        kind: 'sync',
        group: 'ui',
        real: 'passthrough',
        deferred: 'mountWaitSyncVoid',
    },
    {
        name: 'getToolbarSnapshot',
        kind: 'sync',
        group: 'ui',
        real: 'custom',
        deferred: 'custom',
    },
    {
        name: 'waitForDocumentOpenSettled',
        kind: 'async',
        group: 'ui',
        real: 'passthrough',
        deferred: 'mountWaitVoid',
    },
    {
        name: 'runAgentAction',
        kind: 'async',
        group: 'agent',
        real: 'passthrough',
        deferred: 'custom',
    },
    {
        name: 'readAgentResource',
        kind: 'async',
        group: 'agent',
        real: 'passthrough',
        deferred: 'custom',
    },
    {
        name: 'createRecoverySnapshotBytes',
        kind: 'async',
        group: 'automation',
        real: 'custom',
        deferred: 'custom',
    },
    {
        name: 'commentAtPoint',
        kind: 'async',
        group: 'automation',
        real: 'custom',
        deferred: 'custom',
    },
    {
        name: 'getAllShapes',
        kind: 'sync',
        group: 'automation',
        real: 'custom',
        deferred: 'custom',
    },
    {
        name: 'getAutomationStateSnapshot',
        kind: 'sync',
        group: 'automation',
        real: 'custom',
        deferred: 'custom',
    },
    {
        name: 'getDeletedEmbeddedShapeAnnotationIds',
        kind: 'sync',
        group: 'automation',
        real: 'custom',
        deferred: 'custom',
    },
    {
        name: 'getDeletedEmbeddedShapeStableKeys',
        kind: 'sync',
        group: 'automation',
        real: 'custom',
        deferred: 'custom',
    },
    {
        name: 'handleOcrComplete',
        kind: 'async',
        toolbar: {eventName: 'ocr-complete'},
        group: 'automation',
        real: 'passthrough',
        deferred: 'custom',
    },
    {
        name: 'highlightSelection',
        kind: 'async',
        group: 'automation',
        real: 'custom',
        deferred: 'custom',
    },
    {
        name: 'scrollToPage',
        kind: 'sync',
        group: 'automation',
        real: 'custom',
        deferred: 'custom',
    },
] as const);

export type IWorkspaceExposeCommandDescriptor = IWorkspaceExposeCommandDescriptorBase;

type TWorkspaceExposeCommandDescriptor = typeof workspaceExposeCommandRegistry[number];
export type TWorkspaceExposeCommandName = TWorkspaceExposeCommandDescriptor['name'];
export type TWorkspaceExposeSyncCommandName = Extract<
    TWorkspaceExposeCommandDescriptor,
    {readonly kind: 'sync'}
>['name'];
type TWorkspaceExposeMethodForGroup<TGroup extends TWorkspaceExposeCommandGroup> =
    TWorkspaceExposeCommandDescriptor extends infer TDescriptor
        ? TDescriptor extends {
            readonly group: TGroup;
            readonly name: infer TName;
        }
            ? TName
            : never
        : never;
type TWorkspaceExposeCommandResolver = (
    descriptor: TWorkspaceExposeCommandDescriptor,
) => TWorkspaceExposeCommandRunner | null;
type TWorkspaceExposeMenuCommandDescriptor = TWorkspaceExposeCommandDescriptor & {readonly menu: IWorkspaceDocumentMenuCommandDescriptor};
type TWorkspaceExposeToolbarCommandDescriptor = TWorkspaceExposeCommandDescriptor & {readonly toolbar: IWorkspaceToolbarCommandDescriptor};

const workspaceExposeCommandNameSet: ReadonlySet<string> = new Set<TWorkspaceExposeMethod>(
    workspaceExposeCommandRegistry.map(descriptor => descriptor.name),
);
const workspaceExposeSyncCommandNameSet: ReadonlySet<string> = new Set<TWorkspaceExposeSyncCommandName>(
    workspaceExposeCommandRegistry
        .filter((descriptor): descriptor is Extract<TWorkspaceExposeCommandDescriptor, {readonly kind: 'sync'}> => (
            descriptor.kind === 'sync'
        ))
        .map(descriptor => descriptor.name),
);

function isWorkspaceExposeDescriptorForGroup<TGroup extends TWorkspaceExposeCommandGroup>(
    descriptor: TWorkspaceExposeCommandDescriptor,
    group: TGroup,
): descriptor is Extract<TWorkspaceExposeCommandDescriptor, {readonly group: TGroup}> {
    return descriptor.group === group;
}

function appendWorkspaceExposeMethodForGroup<TGroup extends TWorkspaceExposeCommandGroup>(
    methods: Array<TWorkspaceExposeMethodForGroup<TGroup>>,
    descriptor: Extract<TWorkspaceExposeCommandDescriptor, {readonly group: TGroup}>,
) {
    methods.push(descriptor.name as TWorkspaceExposeMethodForGroup<TGroup>);
}

function getWorkspaceExposeMethodsForGroup<TGroup extends TWorkspaceExposeCommandGroup>(group: TGroup) {
    const methods: Array<TWorkspaceExposeMethodForGroup<TGroup>> = [];
    for (const descriptor of workspaceExposeCommandRegistry) {
        if (isWorkspaceExposeDescriptorForGroup(descriptor, group)) {
            appendWorkspaceExposeMethodForGroup(methods, descriptor);
        }
    }
    return methods;
}

function hasDocumentMenuDescriptor(
    descriptor: TWorkspaceExposeCommandDescriptor,
): descriptor is TWorkspaceExposeMenuCommandDescriptor {
    return 'menu' in descriptor && descriptor.menu !== undefined;
}

function hasToolbarDescriptor(
    descriptor: TWorkspaceExposeCommandDescriptor,
): descriptor is TWorkspaceExposeToolbarCommandDescriptor {
    return 'toolbar' in descriptor && descriptor.toolbar !== undefined;
}

export const workspaceExposeMethodDescriptors = {
    file: getWorkspaceExposeMethodsForGroup('file'),
    export: getWorkspaceExposeMethodsForGroup('export'),
    view: getWorkspaceExposeMethodsForGroup('view'),
    pageOps: getWorkspaceExposeMethodsForGroup('pageOps'),
    splitTransfer: getWorkspaceExposeMethodsForGroup('splitTransfer'),
    ui: getWorkspaceExposeMethodsForGroup('ui'),
    agent: getWorkspaceExposeMethodsForGroup('agent'),
    automation: getWorkspaceExposeMethodsForGroup('automation'),
} as const satisfies IWorkspaceExposeMethodDescriptorMap;

export const workspaceExposeRequiredMethodNames = workspaceExposeCommandRegistry
    .map(descriptor => descriptor.name);

export const workspaceExposeMenuCommandDescriptors = workspaceExposeCommandRegistry
    .filter(hasDocumentMenuDescriptor);

export const workspaceExposeToolbarCommandDescriptors = workspaceExposeCommandRegistry
    .filter(hasToolbarDescriptor);

export function isWorkspaceExposeCommandName(value: string): value is TWorkspaceExposeMethod {
    return workspaceExposeCommandNameSet.has(value);
}

export function isWorkspaceExposeSyncCommandName(value: string): value is TWorkspaceExposeSyncCommandName {
    return workspaceExposeSyncCommandNameSet.has(value);
}

export function getWorkspaceViewModeCommandName(mode: TPdfViewMode): TWorkspaceExposeMethod {
    if (mode === 'single') {
        return 'handleViewModeSingle';
    }
    if (mode === 'facing') {
        return 'handleViewModeFacing';
    }
    return 'handleViewModeFacingFirstSingle';
}

export function invokeWorkspaceExposeCommand<TName extends TWorkspaceExposeMethod>(
    workspace: IWorkspaceExpose,
    commandName: TName,
    args?: readonly [...Parameters<TWorkspaceExposeCommandHandler<TName>>],
): ReturnType<TWorkspaceExposeCommandHandler<TName>>;
export function invokeWorkspaceExposeCommand(
    workspace: IWorkspaceExpose,
    commandName: TWorkspaceExposeMethod,
    args?: readonly unknown[],
): unknown;
export function invokeWorkspaceExposeCommand(
    workspace: IWorkspaceExpose,
    commandName: TWorkspaceExposeMethod,
    args: readonly unknown[] = [],
): unknown {
    const command = workspace[commandName];
    if (typeof command !== 'function') {
        throw new WorkspaceExposeCommandUnavailableError(commandName);
    }
    return Reflect.apply(command, workspace, [...args]);
}

export function createWorkspaceExposeCommandRunner<TName extends TWorkspaceExposeMethod>(
    handler: TWorkspaceExposeCommandHandler<TName>,
): TWorkspaceExposeCommandRunner {
    return (...args: unknown[]) => Reflect.apply(handler, undefined, args);
}

export function createWorkspaceExposeCommandHandlers(
    resolveHandler: TWorkspaceExposeCommandResolver,
) {
    const handlers: Partial<Record<TWorkspaceExposeMethod, TWorkspaceExposeCommandRunner>> = {};

    for (const descriptor of workspaceExposeCommandRegistry) {
        const handler = resolveHandler(descriptor);
        if (!handler) {
            throw new Error(`Missing workspace command handler: ${descriptor.name}`);
        }
        handlers[descriptor.name] = handler;
    }

    return handlers as TWorkspaceExposeCommandHandlerMap;
}

export function createWorkspaceExposeFromCommandHandlers(
    hasPdf: IWorkspaceExpose['hasPdf'],
    handlers: TWorkspaceExposeCommandHandlerMap,
    overrides?: Partial<IWorkspaceExpose>,
): IWorkspaceExpose {
    const expose: Record<string, unknown> = {hasPdf};

    for (const descriptor of workspaceExposeCommandRegistry) {
        expose[descriptor.name] = handlers[descriptor.name];
    }

    return {
        ...expose,
        ...overrides,
    } as IWorkspaceExpose;
}
