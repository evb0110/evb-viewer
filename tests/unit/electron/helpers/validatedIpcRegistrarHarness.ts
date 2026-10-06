import type {IpcMainInvokeEvent} from 'electron';
import { expect } from 'vitest';
import type {
    IIpcInvokeSpec,
    IIpcMainRegistrar,
    TIpcCodecMap,
} from '@contracts/ipcMain';
import type { TAnyDefinedPlatformFeature } from '@contracts/platformFeature';
import {
    createChannelSet,
    createValidatedIpcMainRegistrar,
    type IValidatedIpcMainRegistrarOptions,
    type IValidatedIpcMainRegistrar,
} from '@electron/platform-ipc/validatedIpcRegistrar';

export type TCapturedIpcHandler = (
    event: IpcMainInvokeEvent,
    ...args: unknown[]
) => unknown;

export interface IValidatedRegistrarCase {
    channel: string;
    validArgs: unknown[];
}

const stagedArtifactFixture = {
    receiptVersion: 1,
    artifactKind: 'pdf',
    path: '/tmp/staged.pdf',
    size: 512,
    sha256: 'a'.repeat(64),
    fileIdentity: {
        platform: 'posix',
        deviceId: '16777234',
        inode: '918273645',
    },
    validations: {
        qpdfCheck: true,
        tailCheck: true,
        semanticCheck: true,
        fsynced: false,
        qpdfResult: {
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        },
        semanticScopeSha256: 'b'.repeat(64),
        changedObjectRefsSha256: 'c'.repeat(64),
    },
    leaseId: 'lease-fixture',
    revision: null,
} as const;

const scanCleanupOwner = {
    ownerId: 'scan-cleanup-owner',
    documentRevision: 'revision-1',
};
const scanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'color',
    readingOrder: 'ltr',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckle: true,
    skipBlankPages: false,
    pageOverrides: {},
};
const schemaArgsExamples: Readonly<Record<string, unknown[]>> = {
    'scan-cleanup:preview': [{
        ...scanCleanupOwner,
        requestId: 'preview-request-1',
        sourcePdfPath: '/tmp/source.pdf',
        pageNumber: 1,
        options: scanCleanupOptions,
    }],
    'scan-cleanup:placement-anchor-calibration': [{
        ...scanCleanupOwner,
        sourcePdfPath: '/tmp/source.pdf',
        detectionResultStoreId: 'scan-cleanup-fixture-store',
        options: scanCleanupOptions,
        pageNumber: 1,
    }],
    'scan-cleanup:preview:cancel': [{
        ...scanCleanupOwner,
        sourcePdfPath: '/tmp/source.pdf',
    }],
    'scan-cleanup:detect-all': [{
        ...scanCleanupOwner,
        sourcePdfPath: '/tmp/source.pdf',
        options: scanCleanupOptions,
    }],
    'scan-cleanup:detect-all:cancel': [
        'scan-cleanup-fixture',
        scanCleanupOwner,
    ],
    'scan-cleanup:detect-all:get-state': [
        'scan-cleanup-fixture',
        scanCleanupOwner,
    ],
    'scan-cleanup:detect-all:subscribe': [
        'scan-cleanup-fixture',
        scanCleanupOwner,
    ],
    'scan-cleanup:start': [{
        ...scanCleanupOwner,
        sourcePdfPath: '/tmp/source.pdf',
        options: scanCleanupOptions,
    }],
    'scan-cleanup:job:cancel': [
        'scan-cleanup-fixture',
        scanCleanupOwner,
    ],
    'scan-cleanup:job:get-state': [
        'scan-cleanup-fixture',
        scanCleanupOwner,
    ],
    'scan-cleanup:job:subscribe': [
        'scan-cleanup-fixture',
        scanCleanupOwner,
    ],
    'scan-cleanup:job:reconnect': [
        'scan-cleanup-fixture',
        scanCleanupOwner,
    ],
    'scan-cleanup:output:prune': [],
    'scan-cleanup:output:pending': [],
    'scan-cleanup:output:acknowledge': [[]],
    'scan-cleanup:settings:get': [{}],
    'scan-cleanup:settings:update': [{settingsPatch: {preserveOriginalQuality: true}}],
    'dialog:openPdfDirect': ['/tmp/fixture.pdf'],
    'dialog:openPdfDirectBatch': [['/tmp/fixture.pdf']],
    'dialog:openPdfDirectBatch:cancel': ['open-request-1'],
    'working-copy:createFromData': [
        'fixture.pdf',
        new Uint8Array([1]),
    ],
    'working-copy:createFromPath': ['/tmp/fixture.pdf'],
    'working-copy:parseAnnotations': [
        '/tmp/fixture.pdf',
        {expectedDocumentRevisionToken: 'drt1:fixture'},
    ],
    'file:cleanup': ['/tmp/fixture.pdf'],
    'file:read': ['/tmp/fixture.pdf'],
    'pdf:pageLabels:read': ['/tmp/fixture.pdf'],
    'file:stat': ['/tmp/fixture.pdf'],
    'file:readRange': [
        '/tmp/fixture.pdf',
        0,
        1,
    ],
    'pdf:openingGeometry': ['/tmp/fixture.pdf'],
    'pdf:nativePageSizes': [
        '/tmp/fixture.pdf',
        {
            mode: 'exact',
            expectedDocumentRevisionToken: 'drt1:fixture',
        },
    ],
    'pdf:embeddedShapeIndex:begin': [
        '/tmp/fixture.pdf',
        {expectedDocumentRevisionToken: 'drt1:fixture'},
    ],
    'pdf:embeddedShapeIndex:readChunk': [
        'session-fixture',
        0,
    ],
    'pdf:embeddedShapeIndex:release': ['session-fixture'],
    'file:readText': ['/tmp/fixture.pdf'],
    'file:exists': ['/tmp/fixture.pdf'],
    'document:revision:get': ['/tmp/fixture.pdf'],
    'working-copy:backing-status:get': ['/tmp/fixture.pdf'],
    'dialog:savePdfDialog': ['fixture.pdf'],
    'dialog:savePdfAs': [
        '/tmp/fixture.pdf',
        {},
    ],
    'dialog:saveDocxAs': ['/tmp/fixture.docx'],
    'pdf:analyzeConformance': ['/tmp/fixture.pdf'],
    'pdf:validatePath': ['/tmp/fixture.pdf'],
    'pdf:printData': [new Uint8Array([1])],
    'pdf:print:cancel': ['print-request-1'],
    'pdf:printPath': ['/tmp/fixture.pdf'],
    'recentFiles:remove': ['/tmp/fixture.pdf'],
    'recentFiles:removeIfMissing': ['/tmp/fixture.pdf'],
    'recentFiles:readingView': ['/tmp/fixture.pdf'],
    'recentFiles:rememberReadingView': [
        '/tmp/fixture.pdf',
        {
            currentPage: 2,
            pageCount: 3,
            zoom: 1.5,
            zoomMode: 'custom',
            viewMode: 'single',
            continuousScroll: true,
            viewRotation: 0,
        },
    ],
    'window:setTitle': ['fixture.pdf'],
    'shell:showItemInFolder': ['/tmp/fixture.pdf'],
    'menu:setDocumentState': [true],
    'menu:setTabCount': [1],
    'file:write': [
        '/tmp/fixture.pdf',
        new Uint8Array([1]),
    ],
    'file:writeDocx': [
        '/tmp/fixture.docx',
        new Uint8Array([1]),
    ],
    'file:replaceWorkingCopyFromPath': [
        '/tmp/source.pdf',
        '/tmp/target.pdf',
    ],
    'file:saveStructured': ['/tmp/fixture.pdf'],
    'file:createManagedHandle': ['/tmp/fixture.pdf'],
    'file:releaseManagedHandle': ['lease-fixture'],
    'file:repairPdf': ['/tmp/fixture.pdf'],
    'file:optimizePdfForInteraction': ['/tmp/fixture.pdf'],
    'file:optimizePdfAsCopy': [
        '/tmp/fixture.pdf',
        {preset: 'balancedScanned'},
    ],
    'file:savePdfNoteTextUpdates': [
        '/tmp/fixture.pdf',
        [{
            objectNumber: 1,
            generationNumber: 0,
            text: 'note',
        }],
        'D:20240101000000Z',
    ],
    'file:savePdfNoteChanges': [
        '/tmp/fixture.pdf',
        {updates: [{
            objectNumber: 1,
            generationNumber: 0,
            text: 'note',
        }]},
        'D:20240101000000Z',
    ],
    'file:applyPdfNativeMutationsToWorkingCopy': [
        '/tmp/fixture.pdf',
        {updates: [{
            objectNumber: 1,
            generationNumber: 0,
            text: 'note',
        }]},
        'D:20240101000000Z',
        {expectedDocumentRevisionToken: 'drt1:fixture'},
    ],
    'file:commitStagedPdfNativeMutations': [
        '/tmp/fixture.pdf',
        stagedArtifactFixture,
    ],
    'file:cloneStagedPdfNativeMutationToWorkingCopy': [stagedArtifactFixture],
    'file:replaceWorkingCopyFromStagedPdfNativeMutation': [
        '/tmp/fixture.pdf',
        stagedArtifactFixture,
        {expectedDocumentRevisionToken: 'drt1:fixture'},
    ],
    'page-ops:delete': [
        '/tmp/fixture.pdf',
        [1],
        1,
        {
            expectedDocumentRevisionToken: 'drt1:fixture',
            metadataSnapshot: {
                pageLabels: ['1'],
                bookmarks: [],
                untitledBookmarkLabel: 'Untitled',
            },
        },
    ],
    'page-ops:delete-ranges': [
        '/tmp/fixture.pdf',
        [{
            startPage: 1,
            endPage: 1,
        }],
        2,
        undefined,
    ],
    'page-ops:extract': [
        '/tmp/fixture.pdf',
        [1],
    ],
    'page-ops:reorder': [
        '/tmp/fixture.pdf',
        [1],
        undefined,
    ],
    'page-ops:move': [
        '/tmp/fixture.pdf',
        1,
        1,
        0,
        1,
        undefined,
    ],
    'page-ops:move-ranges': [
        '/tmp/fixture.pdf',
        [{
            startPage: 1,
            endPage: 1,
        }],
        0,
        1,
        undefined,
    ],
    'page-ops:insert': [
        '/tmp/fixture.pdf',
        1,
        1,
        undefined,
    ],
    'page-ops:insert-file': [
        '/tmp/fixture.pdf',
        1,
        1,
        ['/tmp/source.pdf'],
        'page-ops-fixture',
        undefined,
    ],
    'page-ops:rotate': [
        '/tmp/fixture.pdf',
        [1],
        1,
        90,
        undefined,
    ],
    'page-ops:crop': [
        '/tmp/fixture.pdf',
        [1],
        1,
        {
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
        },
        undefined,
    ],
    'page-ops:remove-crop': [
        '/tmp/fixture.pdf',
        [1],
        1,
        undefined,
    ],
    'page-ops:cancel-active': ['/tmp/fixture.pdf'],
    'page-ops:get-page-geometry': [
        '/tmp/fixture.pdf',
        1,
    ],
    'pdf:search': [{
        pdfPath: '/tmp/search.pdf',
        query: 'needle',
    }],
    'pdfExport:images': [
        '/tmp/fixture.pdf',
        undefined,
        'image-export-fixture',
        'pdf',
    ],
    'pdfExport:multipage-tiff': [
        '/tmp/fixture.pdf',
        undefined,
        'image-export-fixture',
        'pdf',
    ],
    'pdfExport:region': [
        '/tmp/fixture.pdf',
        1,
        {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            outputWidth: 8,
            outputHeight: 8,
        },
    ],
    'pdf:search:warmIndex': [{pdfPath: '/tmp/search.pdf'}],
    'pdf:search:cancel': ['search-fixture'],
    'tabs:transfer': [{
        target: {
            kind: 'window',
            windowId: 2,
        },
        tab: {
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            isDirty: false,
            isDjvu: false,
        },
        payload: {
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            snapshotPath: '/tmp/snapshot.pdf',
            isDirty: false,
        },
    }],
    'tabs:transferAck': [{
        transferId: 'transfer-1',
        success: true,
    }],
    'app:acknowledgePendingExternalOpenPaths': [['/tmp/sample.pdf']],
    'workspace:checkpointSave': [{
        version: 1,
        capturedAt: 1,
        activePaneId: null,
        activeTabId: null,
        layout: null,
        panes: [],
        tabs: [],
    }],
    'workspace:checkpointResume': ['7'],
    'host:setZenMode': [true],
    'host:writeBugReportBundle': [{
        reportJson: '{}',
        sourcePath: '',
    }],
    'agent:setMcpIntegrationEnabled': [true],
    'agent:startAssistantLogin': [{mode: 'chatgpt'}],
    'agent:sendAssistantMessage': [{text: 'fixture message'}],
    'agent:submitWorkspaceSnapshot': [{
        requestId: 'snapshot-1',
        ok: false,
        error: 'Snapshot unavailable',
    }],
    'agent:submitCommandResponse': [{
        requestId: 'command-1',
        ok: true,
        result: {},
    }],
    'ocr:cancel': ['ocr-cancel-1'],
    'ocr:resolveDocumentTextCatalog': [
        '/tmp/ocr-fixture.pdf',
        'drt1:ocr-fixture',
    ],
    'ocr:resolveDocumentTextCatalogWindow': [
        '/tmp/ocr-fixture.pdf',
        'drt1:ocr-fixture',
        1,
        1,
    ],
    'ocr:resolveDocumentOcrAvailability': [
        '/tmp/ocr-fixture.pdf',
        'drt1:ocr-fixture',
    ],
    'ocr:resolveDocumentOcrPage': [
        '/tmp/ocr-fixture.pdf',
        'drt1:ocr-fixture',
        1,
    ],
    'ocr:ackResultFile': ['ocr-ack-1'],
    'djvu:open:start': [
        '/tmp/sample.djvu',
        'djvu-open-1',
    ],
    'djvu:releaseViewingPath': ['/tmp/sample.djvu'],
    'djvu:convert:start': [
        '/tmp/sample.djvu',
        '/tmp/sample.pdf',
        {requestId: 'djvu-convert-1'},
    ],
    'djvu:printDjvuPath': [
        '/tmp/sample.djvu',
        {
            viewMode: 'single',
            orientation: 'auto',
        },
    ],
    'djvu:cancel': ['djvu-job-1'],
    'djvu:job:getState': ['djvu-job-1'],
    'djvu:cancelPagePreview': ['djvu-preview-1'],
    'djvu:text:search': [
        '/tmp/sample.djvu',
        'needle',
        {
            requestId: 'djvu-search-1',
            pageCount: 1,
        },
    ],
    'djvu:text:cancel': ['djvu-search-1'],
    'djvu:getInfo': ['/tmp/sample.djvu'],
    'djvu:getPageSourceInfo': [
        '/tmp/sample.djvu',
        1,
    ],
    'djvu:getPageSizes': ['/tmp/sample.djvu'],
    'djvu:getPageText': [
        '/tmp/sample.djvu',
        1,
    ],
    'djvu:getOutline': ['/tmp/sample.djvu'],
    'djvu:renderPagePreview': [
        '/tmp/sample.djvu',
        1,
    ],
    'djvu:estimateSizes': ['/tmp/sample.djvu'],
    'djvu:cleanupTemp': ['/tmp/sample.djvu'],
    'ocr:createSearchablePdf': [
        '/tmp/ocr-fixture.pdf',
        [{
            pageNumber: 1,
            languages: ['eng'],
        }],
        'ocr-start-1',
    ],
    'settings:save': [{theme: 'dark'}],
    'shell:openExternal': ['https://example.test/'],
    'updates:skipVersion': ['1.2.3'],
};

export function createFeatureRegistrarCases(feature: TAnyDefinedPlatformFeature): IValidatedRegistrarCase[] {
    const methodCases = Object.values(feature.methods).flatMap((spec) => {
        if (spec.kind === 'sync' || 'local' in spec) {
            return [];
        }
        const validArgs = schemaArgsExamples[spec.channel] ?? [];
        return [{
            channel: spec.channel,
            validArgs,
        }];
    });
    const subscriptionCases = Object.values(feature.events).flatMap((spec) => (
        spec.subscription
            ? [{
                channel: spec.subscription.channel,
                validArgs: [],
            }]
            : []
    ));
    return [
        ...methodCases,
        ...subscriptionCases,
    ];
}

export function createValidatedRegistrarHarness<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec},
    TService,
>(options: {
    channels: Record<string, string>;
    codecs: TIpcCodecMap<TMap>;
    register: (registrar: IValidatedIpcMainRegistrar<TMap, IpcMainInvokeEvent>, service: TService) => void;
    service: TService;
}) {
    const handlers = new Map<string, TCapturedIpcHandler>();
    const nativeRegistrar: IIpcMainRegistrar<never, IpcMainInvokeEvent> = {handle: ((
        channel: string,
        handler: TCapturedIpcHandler,
    ) => {
        handlers.set(channel, handler);
    }) as IIpcMainRegistrar<never, IpcMainInvokeEvent>['handle']};
    const allowedChannels = createChannelSet(options.channels);
    const registrarOptions: IValidatedIpcMainRegistrarOptions = {
        allowedChannels,
        codecs: options.codecs,
    };
    const registrar = createValidatedIpcMainRegistrar<TMap>(nativeRegistrar, registrarOptions);
    options.register(registrar, options.service);
    return handlers;
}

export function getCapturedIpcHandler(
    handlers: ReadonlyMap<string, TCapturedIpcHandler>,
    channel: string,
) {
    const handler = handlers.get(channel);
    if (handler === undefined) {
        throw new Error(`Expected a registered IPC handler for ${channel}`);
    }
    return handler;
}

export function createHarnessEvent(senderId = 7) {
    return {sender: {id: senderId}} as IpcMainInvokeEvent;
}

export async function assertValidatedRegistrarCases(options: {
    cases: readonly IValidatedRegistrarCase[];
    channels: Record<string, string>;
    handlers: ReadonlyMap<string, TCapturedIpcHandler>;
    setTrusted: (trusted: boolean) => void;
}) {
    const expectedChannels = [...new Set(Object.values(options.channels))].sort();
    expect([...options.handlers.keys()].sort()).toEqual(expectedChannels);
    expect(options.cases.map(testCase => testCase.channel).sort()).toEqual(expectedChannels);

    for (const testCase of options.cases) {
        const handler = getCapturedIpcHandler(options.handlers, testCase.channel);
        options.setTrusted(true);
        await expect(handler(createHarnessEvent(), ...testCase.validArgs)).resolves.not.toThrow();

        for (let index = 0; index < testCase.validArgs.length; index += 1) {
            const malformedArgs = [...testCase.validArgs];
            malformedArgs[index] = Symbol('malformed');
            await expect(handler(createHarnessEvent(), ...malformedArgs)).rejects.toThrow(
                `Invalid IPC arguments for ${testCase.channel}`,
            );
        }
        await expect(handler(createHarnessEvent(), ...testCase.validArgs, Symbol('extra'))).rejects.toThrow(
            `Invalid IPC arguments for ${testCase.channel}`,
        );

        options.setTrusted(false);
        await expect(handler(createHarnessEvent(), ...testCase.validArgs)).rejects.toThrow('IPC sender is not trusted');
    }
}
