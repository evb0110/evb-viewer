import type { Component } from 'vue';
import { didOpenDocument } from '@app/types/documentOpenOutcome';
import {
    createDefaultWorkspaceViewerCapabilities,
    type IWorkspaceViewerCapabilities,
} from '@app/types/workspaceExpose';
import type {
    IWorkspaceViewerAdapter,
    IWorkspaceViewerLifecycleContext,
    IWorkspaceViewerLifecycleHooks,
    IWorkspaceViewerResolveContext,
    TWorkspaceViewerAdapterId,
    TWorkspaceViewerDocumentType,
} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';
import { workspaceViewerChunkLoaders } from '@app/modules/workspace-shell/viewers/workspaceViewerChunkLoaders';
import type { TPdfViewMode } from '@contracts/shared';

const DocumentViewerChassis = defineAsyncComponent(
    () => workspaceViewerChunkLoaders.chassis()
        .then(componentModule => componentModule.default),
) as Component;

const PDF_VIEWER_CAPABILITIES: IWorkspaceViewerCapabilities = {
    ...createDefaultWorkspaceViewerCapabilities(),
    closeableDocument: true,
    crop: true,
    optimizePdf: true,
    pdfDocument: true,
    pdfMutationActions: true,
    print: true,
    regionCapture: true,
    repairSave: true,
    save: true,
    saveAs: true,
    sidebar: true,
    continuousScroll: true,
    viewMode: true,
    viewRotation: true,
};

const NATIVE_PDF_VIEWER_CAPABILITIES: IWorkspaceViewerCapabilities = {
    ...createDefaultWorkspaceViewerCapabilities(),
    closeableDocument: true,
    pdfDocument: true,
    print: true,
};

const DJVU_VIEWER_CAPABILITIES: IWorkspaceViewerCapabilities = {
    ...createDefaultWorkspaceViewerCapabilities(),
    closeableDocument: true,
    conversionBanner: true,
    conversionDialog: true,
    pdfMutationActions: true,
    print: true,
    saveAs: true,
    sidebar: true,
    continuousScroll: true,
    viewMode: false,
    viewRotation: false,
};

export function resolveWorkspaceViewerViewMode(
    capabilities: Pick<IWorkspaceViewerCapabilities, 'viewMode'> | undefined,
    storedViewMode: TPdfViewMode,
): TPdfViewMode {
    return capabilities?.viewMode === true ? storedViewMode : 'single';
}

function createDjvuLifecycleHooks(context: IWorkspaceViewerLifecycleContext): IWorkspaceViewerLifecycleHooks {
    return {
        beforeOpen: () => {
            context.invalidatePendingDjvuOpen();
        },
        afterOpen: async (outcome, state) => {
            if (
                didOpenDocument(outcome)
                && outcome.result.kind === 'pdf'
                && context.isDjvuMode.value
                && context.workingCopyPath.value !== state.previousWorkingCopyPath
            ) {
                const activation = context.captureDjvuActivation();
                if (activation) {
                    await context.cleanupDjvuTemp(activation);
                    context.exitDjvuMode(activation);
                }
            }
        },
        beforeClose: async () => {
            context.invalidatePendingDjvuOpen();
            const activation = context.captureDjvuActivation();
            if (activation) {
                await context.cleanupDjvuTemp(activation);
                context.exitDjvuMode(activation);
            }
        },
    };
}

export const WORKSPACE_VIEWER_ADAPTERS: readonly IWorkspaceViewerAdapter[] = [
    {
        id: 'pdf',
        component: DocumentViewerChassis,
        documentTypes: [
            'pdf',
            'image',
        ],
        capabilities: PDF_VIEWER_CAPABILITIES,
    },
    {
        id: 'native-pdf',
        component: DocumentViewerChassis,
        documentTypes: ['pdf'],
        capabilities: NATIVE_PDF_VIEWER_CAPABILITIES,
    },
    {
        id: 'djvu',
        component: DocumentViewerChassis,
        documentTypes: ['djvu'],
        capabilities: DJVU_VIEWER_CAPABILITIES,
        createLifecycleHooks: createDjvuLifecycleHooks,
    },
] as const satisfies readonly IWorkspaceViewerAdapter[];

export function getWorkspaceViewerAdapter(adapterId: TWorkspaceViewerAdapterId): IWorkspaceViewerAdapter {
    const adapter = WORKSPACE_VIEWER_ADAPTERS.find(candidate => candidate.id === adapterId);
    if (!adapter) {
        throw new Error(`Workspace viewer adapter "${adapterId}" is not registered.`);
    }
    return adapter;
}

export function resolveWorkspaceViewerAdapter(
    context: IWorkspaceViewerResolveContext,
): IWorkspaceViewerAdapter | null {
    if (context.isDjvuMode && context.djvuSourcePath && !context.pdfSourcePath) {
        return getWorkspaceViewerAdapter('djvu');
    }

    if (context.pdfSourcePath) {
        return context.shouldUseNativePdf
            ? getWorkspaceViewerAdapter('native-pdf')
            : getWorkspaceViewerAdapter('pdf');
    }

    return null;
}

// Pending/pre-mount records cannot know yet whether a PDF routes to the
// native viewer (a size-based decision made at resolve time); each document
// type therefore seeds from an explicit default adapter, and the mounted
// workspace overwrites capabilities with the resolved adapter's set.
const DEFAULT_VIEWER_ADAPTER_ID_BY_DOCUMENT_TYPE: Record<TWorkspaceViewerDocumentType, TWorkspaceViewerAdapterId> = {
    pdf: 'pdf',
    image: 'pdf',
    djvu: 'djvu',
};

export function getWorkspaceViewerCapabilitiesForDocumentType(
    documentType: TWorkspaceViewerDocumentType,
): IWorkspaceViewerCapabilities {
    return getWorkspaceViewerAdapter(DEFAULT_VIEWER_ADAPTER_ID_BY_DOCUMENT_TYPE[documentType]).capabilities;
}

export function createWorkspaceViewerLifecycleHooks(
    context: IWorkspaceViewerLifecycleContext,
): IWorkspaceViewerLifecycleHooks[] {
    return WORKSPACE_VIEWER_ADAPTERS.flatMap(adapter => (
        adapter.createLifecycleHooks ? [adapter.createLifecycleHooks(context)] : []
    ));
}

export function hasWorkspaceViewerDocumentCapabilities(
    capabilities: IWorkspaceViewerCapabilities | undefined,
) {
    return capabilities?.closeableDocument === true;
}
