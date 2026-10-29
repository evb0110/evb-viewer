import {mapPdfAnnotationParseEntity} from '@app/modules/pdf-viewer/runtime/sessions/mapPdfAnnotationParseEntity';
import type {TPdfAnnotationParseEntity} from '@contracts/pdfAnnotationParseTypes';
import {getDocumentWorkingCopyCapability} from '@app/utils/platformDocuments';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
    shallowRef,
} from 'vue';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageIndex} from '@contracts/pageNumbers';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    asAnnotationId,
    toLegacyShapeAnnotation,
    type INoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {usePdfViewerSaveTransaction} from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';
import type {IWorkspaceSaveDependencies} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import {cast} from '@tests/helpers/cast';
import {
    createDeferred,
    createDeps,
    useWorkspaceSaveServiceForTest,
} from '@tests/unit/app/modules/workspace-shell/composables/file-operations/workspaceSaveServiceFixture';

function savedNote(): INoteEntity {
    return {
        kind: 'note',
        identity: {
            id: asAnnotationId('saved-note'),
            pdfRef: '12R',
        },
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        contents: 'saved text',
        color: '#ffff00',
        open: false,
        position: {
            left: 0.1,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        },
    };
}

describe('concurrent canonical edits during workspace save', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
        'save',
        'save-as',
    ] as const)('retains accepted note text and deletion when the native writer fails during %s', async (mode) => {
        const application = new AnnotationApplication('failed-native-save');
        const edited = savedNote();
        const deleted = {
            ...savedNote(),
            identity: {
                id: asAnnotationId('deleted-note'),
                pdfRef: '13R',
            },
        };
        application.store.replaceFromDocument([
            edited,
            deleted,
        ], []);
        application.store.updateNote(edited.identity.id, {contents: 'accepted unsaved text'});
        application.store.delete(deleted.identity.id);
        const {
            deps, saveFile,
        } = createDeps({
            originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            annotationDirty: ref(true),
            hasAnnotationChanges: () => application.store.hasChangesSinceSavedBaseline(),
            trySavePdfNativeMutations: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            })),
        });
        const transaction = usePdfViewerSaveTransaction({
            getPdfDocument: () => deps.pdfDocument.value,
            annotationApplication: shallowRef(application),
            documentRevisionToken: computed(() => deps.documentRevisionToken.value),
        });
        deps.runSaveTransaction = request => transaction.runSaveTransaction(request);
        const service = useWorkspaceSaveServiceForTest(deps);
        await expect(mode === 'save' ? service.handleSave() : service.handleSaveAs()).resolves.toBe(false);
        expect(deps.trySavePdfNativeMutations).toHaveBeenCalledWith(expect.objectContaining({
            updates: [expect.objectContaining({text: 'accepted unsaved text'})],
            deletes: [expect.objectContaining({objectNumber: 13})],
        }), expect.anything());
        expect(saveFile).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopyAs).not.toHaveBeenCalled();
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
        expect(service.hasSaveFailure.value).toBe(true);
        expect(application.store.get(edited.identity.id)).toMatchObject({
            contents: 'accepted unsaved text',
            persistedRevision: 0,
        });
        expect(application.store.get(deleted.identity.id)).toMatchObject({
            deleted: true,
            persistedRevision: 0,
        });
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(true);
    });

    it.each([
        {
            mode: 'save',
            capturedEdit: false,
        },
        {
            mode: 'save-as',
            capturedEdit: false,
        },
        {
            mode: 'save',
            capturedEdit: true,
        },
        {
            mode: 'save-as',
            capturedEdit: true,
        },
    ] as const)('retains newer text and history for $mode with capturedEdit=$capturedEdit', async ({
        mode,
        capturedEdit,
    }) => {
        const application = new AnnotationApplication('concurrent-save');
        const note = savedNote();
        application.store.replaceFromDocument([note], []);
        if (capturedEdit) application.store.updateNote(note.identity.id, {contents: 'captured text'});
        const enteredPersistence = createDeferred<undefined>();
        const finishPersistence = createDeferred<undefined>();
        const originalPath = ref(requireDocumentRef('/tmp/source.pdf'));
        const workingCopyPath = ref(requireDocumentRef('/tmp/work.pdf'));
        const revision = ref(requireDocumentRevisionToken('rev-1'));
        const {deps} = createDeps({
            originalPath,
            workingCopyPath,
            documentRevisionToken: revision,
            annotationDirty: ref(true),
            hasAnnotationChanges: () => true,
            getAnnotationSaveStateToken: () => application.store.mutationEpoch,
            trySavePdfNativeMutations: vi.fn(),
        });
        const transaction = usePdfViewerSaveTransaction({
            getPdfDocument: () => deps.pdfDocument.value,
            annotationApplication: shallowRef(application),
            documentRevisionToken: computed(() => revision.value),
        });
        deps.runSaveTransaction = request => transaction.runSaveTransaction(request);
        async function publishCapturedBytes() {
            enteredPersistence.resolve(undefined);
            await finishPersistence.promise;
            if (mode === 'save-as') originalPath.value = requireDocumentRef('/tmp/new.pdf');
            revision.value = requireDocumentRevisionToken('rev-2');
            return {
                success: true,
                outPath: originalPath.value,
                saveMode: mode === 'save-as' ? 'save_as_rewrite' as const : 'rewrite' as const,
                didSaveAs: mode === 'save-as',
            };
        }
        vi.spyOn(getDocumentWorkingCopyCapability(), 'parsePdfAnnotations').mockImplementation(async () => ({
            documentRevisionToken: revision.value,
            pageCount: 1,
            entities: [],
            foreign: [],
        }));
        deps.trySavePdfNativeMutations = vi.fn(publishCapturedBytes);
        deps.saveWorkingCopy = vi.fn(publishCapturedBytes);
        deps.saveWorkingCopyAs = vi.fn(publishCapturedBytes);
        const service = useWorkspaceSaveServiceForTest(deps);
        const saving = mode === 'save-as' ? service.handleSaveAs() : service.handleSave();
        await enteredPersistence.promise;

        application.store.updateNote(note.identity.id, {contents: 'newer unsaved text'});
        finishPersistence.resolve(undefined);
        await expect(saving).resolves.toBe(true);

        expect(application.store.get(note.identity.id)).toMatchObject({
            contents: 'newer unsaved text',
            persistedRevision: capturedEdit ? 1 : 0,
        });
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(application.store.undo()).toBe(true);
        if (capturedEdit) {
            expect(application.store.get(note.identity.id)).toMatchObject({contents: 'captured text'});
            expect(application.store.undo()).toBe(true);
        }
        expect(application.store.get(note.identity.id)).toMatchObject({contents: 'saved text'});
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(capturedEdit);
        expect(application.store.redo()).toBe(true);
        if (capturedEdit) expect(application.store.redo()).toBe(true);
        expect(application.store.get(note.identity.id)).toMatchObject({contents: 'newer unsaved text'});
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(true);
    });
});

describe('save requests while the document lease is held', () => {
    it.each([
        {
            mode: 'save',
            indicator: 'isSaving',
        },
        {
            mode: 'save-as',
            indicator: 'isSavingAs',
        },
    ] as const)('keeps $mode busy while it waits for the document lease', async ({
        mode, indicator,
    }) => {
        const gate = createDeferred<undefined>();
        const {
            deps, saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            runWithDocumentOperationLease: cast<NonNullable<IWorkspaceSaveDependencies['runWithDocumentOperationLease']>>(
                async (_kind: unknown, operation: () => Promise<unknown>) => {
                    await gate.promise;
                    return operation();
                },
            ),
        });
        const service = useWorkspaceSaveServiceForTest(deps);
        const startSave = () => mode === 'save-as' ? service.handleSaveAs() : service.handleSave();
        const writes = () => saveFile.mock.calls.length
            + vi.mocked(deps.saveWorkingCopy).mock.calls.length
            + vi.mocked(deps.saveWorkingCopyAs).mock.calls.length;

        const first = startSave();
        await vi.waitFor(() => expect(deps[indicator].value).toBe(true));
        expect(service.isAnySaving.value).toBe(true);
        expect(service.isAnySaveAdmitted.value).toBe(false);

        expect(writes()).toBe(0);

        gate.resolve(undefined);
        await expect(first).resolves.toBe(true);
        expect(writes()).toBe(1);
        expect(deps[indicator].value).toBe(false);
        expect(service.isAnySaving.value).toBe(false);
        expect(service.isAnySaveAdmitted.value).toBe(false);
    });
});

function parsedAdditive(kind: 'highlight' | 'shape' | 'text-box' | 'stamp'): TPdfAnnotationParseEntity {
    const base = {
        pageIndex: requirePageIndex(0),
        objectNumber: 50,
        generationNumber: 0,
        name: 'fresh',
        author: null,
        createdAt: null,
        modifiedAt: null,
    };
    const rect = {
        left: 0.1,
        top: 0.2,
        width: 0.3,
        height: 0.1,
    };
    if (kind === 'highlight') return {
        ...base,
        kind,
        subtype: 'Highlight',
        quadPoints: [rect],
        color: '#ffff00',
        opacity: 0.5,
        contents: '',
    };
    if (kind === 'text-box') return {
        ...base,
        kind,
        text: 'Fresh text',
        rect,
        rotation: 0,
        fontSize: 12,
        color: '#123456',
    };
    if (kind === 'stamp') return {
        ...base,
        kind,
        rect,
        rotation: 0,
        image: {
            objectNumber: 42,
            generationNumber: 0,
            byteLength: 20,
            sha256: 'a'.repeat(64),
        },
    };
    return {
        ...base,
        kind,
        stableKey: 'fresh',
        pdfSubtype: 'Square',
        type: 'rectangle',
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        color: '#123456',
        fillColor: null,
        opacity: 1,
        strokeWidth: 2,
        points: null,
        strokes: null,
        x2: null,
        y2: null,
        lineStartStyle: null,
        lineEndStyle: null,
    };
}

describe('scoped annotation save readback through transaction and workspace service', () => {
    afterEach(() => vi.restoreAllMocks());
    for (const existing of [
        false,
        true,
    ]) {
        for (const kind of [
            'highlight',
            'shape',
            'text-box',
            'stamp',
        ] as const) {
            if (existing && kind === 'stamp') continue;
            it.each([
                'recognized',
                'missing',
                'foreign',
            ] as const)(`${existing ? 'existing' : 'new'} ${kind} readback: %s`, async (readback) => {
                const application = new AnnotationApplication('additive-save');
                const outside = {
                    ...savedNote(),
                    pageIndex: requirePageIndex(1),
                };
                application.store.replaceFromDocument([outside], []);
                const parsed = parsedAdditive(kind);
                const mapped = mapPdfAnnotationParseEntity(parsed);
                const fresh = {
                    ...mapped,
                    identity: {id: mapped.identity.id},
                    persistedRevision: -1,
                };
                if (fresh.kind === 'shape') application.store.createShape({
                    ...fresh,
                    materialized: false,
                });
                else if (fresh.kind === 'text-box') application.store.createTextBox(fresh);
                else if (fresh.kind === 'text-markup') application.store.createTextMarkup(fresh);
                else if (fresh.kind === 'placed-image') application.store.createPlacedImage({
                    ...fresh,
                    image: {
                        kind: 'raster',
                        mimeType: 'image/png',
                        dataBase64: 'cG5n',
                        byteLength: 3,
                        sha256: 'b'.repeat(64),
                        width: 1,
                        height: 1,
                    },
                });
                if (existing) {
                    application.store.replaceFromDocument([
                        outside,
                        mapped,
                    ], []);
                    if (mapped.kind === 'shape') application.store.updateShape(mapped.identity.id, {strokeWidth: 3});
                    if (mapped.kind === 'text-markup') application.store.updateTextMarkup(mapped.identity.id, {color: '#22c55e'});
                    if (mapped.kind === 'text-box') application.store.updateTextBox(mapped.identity.id, {text: 'edited'});
                    if (mapped.kind === 'placed-image') application.store.updatePlacedImage(mapped.identity.id, {rotation: 30});
                }
                const revision = ref(requireDocumentRevisionToken('rev-1'));
                const {deps} = createDeps({
                    originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
                    workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
                    documentRevisionToken: revision,
                    totalPages: ref(2),
                    annotationDirty: ref(true),
                    hasAnnotationChanges: () => true,
                    hasShapeChanges: () => kind === 'shape',
                    getAllShapes: () => application.store.list().filter(entity => entity.kind === 'shape').map(toLegacyShapeAnnotation),
                    getAnnotationSaveStateToken: () => application.store.mutationEpoch,
                    trySavePdfNativeMutations: vi.fn(async () => {
                        revision.value = requireDocumentRevisionToken('rev-2');
                        return {
                            success: true,
                            outPath: requireDocumentRef('/tmp/work.pdf'),
                            saveMode: 'rewrite' as const,
                            didSaveAs: false,
                            ...(existing ? {annotationDeleteEffects: {
                                affectedPageIndices: [0],
                                deletedReplyRefs: [],
                            }} : {}),
                            materializedIdentityBindings: [{
                                annotationId: 'fresh',
                                pdfRef: '50 0 R',
                            }],
                        };
                    }),
                });
                deps.pdfDocument.value = cast({
                    ...deps.pdfDocument.value,
                    getPage: async () => ({
                        view: [
                            0,
                            0,
                            200,
                            100,
                        ],
                        rotate: 0,
                    }),
                });
                const transaction = usePdfViewerSaveTransaction({
                    getAllShapes: () => deps.getAllShapes?.() ?? [],
                    getDeletedEmbeddedShapeAnnotationIds: () => deps.getDeletedEmbeddedShapeAnnotationIds?.() ?? [],
                    getDeletedEmbeddedShapeStableKeys: () => deps.getDeletedEmbeddedShapeStableKeys?.() ?? [],
                    getPdfDocument: () => deps.pdfDocument.value,
                    annotationApplication: shallowRef(application),
                    documentRevisionToken: computed(() => revision.value),
                });
                deps.runSaveTransaction = request => transaction.runSaveTransaction(request);
                const scopes: Array<readonly number[] | undefined> = [];
                vi.spyOn(getDocumentWorkingCopyCapability(), 'parsePdfAnnotations').mockImplementation(async (_path, options) => {
                    scopes.push(options.pageIndices);
                    expect(options.expectedDocumentRevisionToken).toBe('rev-2');
                    if (!options.pageIndices) {
                    // The rejected scoped parse must not have dropped the saved upsert.
                        expect(application.store.get(mapped.identity.id)?.kind).toBe(mapped.kind);
                    }
                    return {
                        documentRevisionToken: revision.value,
                        pageCount: 2,
                        ...(options.pageIndices ? {pageIndices: [...options.pageIndices]} : {}),
                        entities: options.pageIndices && readback !== 'recognized' ? [] : [parsed],
                        foreign: options.pageIndices && readback === 'foreign' ? [{
                            kind: 'foreign',
                            pageIndex: requirePageIndex(0),
                            objectNumber: 50,
                            generationNumber: 0,
                            name: 'fresh',
                            subtype: 'Unsupported',
                            reason: 'unrecognized',
                        }] : [],
                    };
                });
                await expect(useWorkspaceSaveServiceForTest(deps).handleSave()).resolves.toBe(true);
                expect(scopes).toEqual(readback === 'recognized' ? [[0]] : [
                    [0],
                    undefined,
                ]);
                expect(application.store.get(mapped.identity.id)).toMatchObject({
                    kind: mapped.kind,
                    identity: {pdfRef: '50 0 R'},
                });
                if (readback === 'recognized') expect(application.store.get(outside.identity.id)).toEqual(outside);
                expect(application.store.hasChangesSinceSavedBaseline()).toBe(false);
            });
        }
    }
});

describe('bookmark-only save readback', () => {
    afterEach(() => vi.restoreAllMocks());
    it.each([
        false,
        true,
    ])('reads no annotations back, whether or not the store holds the whole document (read whole: %s)', async (readWhole) => {
        // The viewer reads the saved revision of a partial store once the save lets go.
        const application = new AnnotationApplication('bookmark-save');
        if (readWhole) application.store.replaceFromDocument([savedNote()], []);
        const revision = ref(requireDocumentRevisionToken('rev-1'));
        const {deps} = createDeps({
            originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            documentRevisionToken: revision,
            bookmarksDirty: ref(true),
            bookmarkItems: ref(cast([{
                title: 'First bookmark',
                pageIndex: 0,
                items: [],
            }])),
            trySavePdfNativeMutations: vi.fn(async () => {
                revision.value = requireDocumentRevisionToken('rev-2');
                return {
                    success: true,
                    outPath: requireDocumentRef('/tmp/work.pdf'),
                    saveMode: 'rewrite' as const,
                    didSaveAs: false,
                };
            }),
        });
        const transaction = usePdfViewerSaveTransaction({
            getPdfDocument: () => deps.pdfDocument.value,
            annotationApplication: shallowRef(application),
            documentRevisionToken: computed(() => revision.value),
        });
        deps.runSaveTransaction = request => transaction.runSaveTransaction(request);
        const parse = vi.spyOn(getDocumentWorkingCopyCapability(), 'parsePdfAnnotations').mockImplementation(async () => cast({
            documentRevisionToken: revision.value,
            pageCount: 1,
            entities: [{
                kind: 'note',
                pageIndex: requirePageIndex(0),
                objectNumber: 12,
                generationNumber: 0,
                name: 'saved-note',
                author: null,
                createdAt: null,
                modifiedAt: null,
                position: savedNote().position,
                contents: 'saved text',
                color: null,
                open: false,
            }],
            foreign: [],
        }));
        await expect(useWorkspaceSaveServiceForTest(deps).handleSave()).resolves.toBe(true);
        expect(parse).not.toHaveBeenCalled();
        expect(application.listCommentSummaries().map(summary => summary.text)).toEqual(readWhole ? ['saved text'] : []);
    });
});

describe('native deletion readback', () => {
    afterEach(() => vi.restoreAllMocks());
    for (const kind of [
        'note',
        'shape',
    ] as const) {
        it.each([
            'confirmed',
            'no-proof',
        ] as const)(`${kind} uses the published deletion scope: %s`, async mode => {
            const application = new AnnotationApplication('delete-readback');
            const deleted = kind === 'note' ? savedNote() : mapPdfAnnotationParseEntity(parsedAdditive('shape'));
            const outside = {
                ...savedNote(),
                identity: {
                    id: asAnnotationId('outside'),
                    pdfRef: '20R',
                },
                pageIndex: requirePageIndex(2),
            };
            application.store.replaceFromDocument([
                deleted,
                outside,
            ], []);
            application.store.delete(deleted.identity.id);
            const revision = ref(requireDocumentRevisionToken('rev-1'));
            const {deps} = createDeps({
                originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
                workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
                documentRevisionToken: revision,
                totalPages: ref(3),
                hasShapeChanges: () => kind === 'shape',
                getDeletedEmbeddedShapeAnnotationIds: () => kind === 'shape' ? ['50R'] : [],
                getDeletedEmbeddedShapeStableKeys: () => kind === 'shape' ? ['fresh'] : [],
                annotationDirty: ref(true),
                hasAnnotationChanges: () => true,
                getAnnotationSaveStateToken: () => application.store.mutationEpoch,
                trySavePdfNativeMutations: vi.fn(async () => {
                    revision.value = requireDocumentRevisionToken('rev-2');
                    return {
                        success: true,
                        outPath: requireDocumentRef('/tmp/work.pdf'),
                        saveMode: 'rewrite' as const,
                        didSaveAs: false,
                        ...(mode === 'no-proof' ? {} : {annotationDeleteEffects: {
                            affectedPageIndices: [
                                0,
                                1,
                            ],
                            deletedReplyRefs: ['13 0 R'],
                        }}),
                    };
                }),
            });
            const transaction = usePdfViewerSaveTransaction({
                getAllShapes: () => [],
                getDeletedEmbeddedShapeAnnotationIds: () => deps.getDeletedEmbeddedShapeAnnotationIds?.() ?? [],
                getDeletedEmbeddedShapeStableKeys: () => deps.getDeletedEmbeddedShapeStableKeys?.() ?? [],
                getPdfDocument: () => deps.pdfDocument.value,
                annotationApplication: shallowRef(application),
                documentRevisionToken: computed(() => revision.value),
            });
            deps.runSaveTransaction = request => transaction.runSaveTransaction(request);
            const scopes: Array<readonly number[] | undefined> = [];
            vi.spyOn(getDocumentWorkingCopyCapability(), 'parsePdfAnnotations').mockImplementation(async (_path, options) => {
                scopes.push(options.pageIndices);
                expect(options.expectedDocumentRevisionToken).toBe('rev-2');
                return {
                    documentRevisionToken: revision.value,
                    pageCount: 3,
                    ...(options.pageIndices ? {pageIndices: [...options.pageIndices]} : {}),
                    entities: [],
                    foreign: [],
                };
            });
            await expect(useWorkspaceSaveServiceForTest(deps).handleSave()).resolves.toBe(true);
            expect(scopes).toEqual(mode === 'no-proof' ? [undefined] : [[
                0,
                1,
            ]]);
            if (mode !== 'no-proof') expect(application.store.get(outside.identity.id)).toEqual(outside);
            expect(application.store.get(deleted.identity.id)?.deleted ?? true).toBe(true);
            expect(application.store.undo()).toBe(true);
            expect(application.store.get(deleted.identity.id)?.deleted).toBe(false);
            expect(application.store.get(deleted.identity.id)?.identity.pdfRef).toBeUndefined();
        });
    }
});
