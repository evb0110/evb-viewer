import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    shallowReactive,
    shallowRef,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    asAnnotationId,
    type AnnotationEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {usePdfAnnotationEditorSurface} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type {
    IAnnotationMarkerRect,
    TAnnotationTool,
} from '@app/types/annotations';
import {createPdfDocumentAnnotations} from '@app/modules/pdf-viewer/runtime/sessions/createPdfDocumentAnnotations';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageIndex} from '@contracts/pageNumbers';

const rect: IAnnotationMarkerRect = {
    left: 0.1,
    top: 0.2,
    width: 0.2,
    height: 0.05,
};

function baseEntity(id: string, pageIndex = 0) {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(pageIndex),
        revision: 0,
        persistedRevision: -1,
        deleted: false as const,
        createdAt: null,
        modifiedAt: null,
        author: null,
    };
}

function createSurfaceHarness(options: Partial<Parameters<typeof usePdfAnnotationEditorSurface>[0]> = {}) {
    const annotationApplication = options.annotationApplication ?? shallowRef(new AnnotationApplication('surface-test'));
    const isActive = shallowRef(true);
    const emitAnnotationModified = vi.fn();
    const emitShapeContextMenu = vi.fn();
    const onCreationCompleted = vi.fn();
    const onTextBoxDraftChanged = vi.fn();
    const scope = effectScope();
    activeScopes.add(scope);
    const surface = scope.run(() => usePdfAnnotationEditorSurface({
        annotationApplication,
        isActive: computed(() => isActive.value),
        activeTool: computed<TAnnotationTool>(() => 'select'),
        settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
        emitAnnotationModified,
        emitShapeContextMenu,
        onCreationCompleted,
        onTextBoxDraftChanged,
        ...options,
    }))!;
    const stop = () => {
        if (!activeScopes.delete(scope)) {
            return;
        }
        scope.stop();
    };
    return {
        annotationApplication,
        isActive,
        emitAnnotationModified,
        emitShapeContextMenu,
        onCreationCompleted,
        onTextBoxDraftChanged,
        surface,
        stop,
    };
}

const activeScopes = new Set<ReturnType<typeof effectScope>>();

describe('usePdfAnnotationEditorSurface', () => {
    it('returns focus only to the still-selected annotation without replacing a multi-selection', () => {
        const {
            surface,
            isActive,
        } = createSurfaceHarness();
        const first = surface.createNoteAt(0, rect);
        const second = surface.createNoteAt(0, rect);
        const focus = vi.fn();
        surface.registerPageInteraction(0, {
            commitTextDraft: vi.fn(),
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus,
        });
        surface.select([
            first.identity.id,
            second.identity.id,
        ]);
        expect(surface.focusSelectedAnnotation(first.identity.id)).toBe(true);
        expect(focus).toHaveBeenCalledOnce();
        expect(surface.selectedIds.value).toEqual(new Set([
            first.identity.id,
            second.identity.id,
        ]));
        surface.select([second.identity.id]);
        expect(surface.focusSelectedAnnotation(first.identity.id)).toBe(false);
        expect(focus).toHaveBeenCalledOnce();
        isActive.value = false;
        expect(surface.focusSelectedAnnotation(second.identity.id)).toBe(false);
        expect(focus).toHaveBeenCalledOnce();
    });

    it('completes a new text creation only after its accepted draft, never on cancellation', () => {
        const {
            surface,
            onCreationCompleted,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        surface.beginTextEditing(box.identity.id);
        expect(onCreationCompleted).not.toHaveBeenCalled();
        surface.endTextEditing(box.identity.id, {
            created: true,
            cancelled: true,
        });
        expect(onCreationCompleted).not.toHaveBeenCalled();
        surface.beginTextEditing(box.identity.id);
        surface.endTextEditing(box.identity.id, {created: true});
        expect(onCreationCompleted).toHaveBeenCalledExactlyOnceWith('text');
    });

    it('Escape cancels the pointer operation before touching selection or the active text session', () => {
        const {
            surface,
            onCreationCompleted,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        const cancelPointerGesture = vi.fn();
        const cancelTextDraft = vi.fn(() => surface.endTextEditing(box.identity.id, {cancelled: true}));
        surface.registerPageInteraction(0, {
            commitTextDraft: vi.fn(),
            cancelTextDraft,
            cancelPointerGesture,
            focus: vi.fn(),
        });
        surface.beginTextEditing(box.identity.id);
        surface.beginPointerInteraction(0);
        expect(surface.handleEscape()).toBe(true);
        expect(cancelPointerGesture).toHaveBeenCalledOnce();
        expect(cancelTextDraft).not.toHaveBeenCalled();
        expect(surface.selectedIds.value.has(box.identity.id)).toBe(true);
        expect(surface.handleEscape()).toBe(true);
        expect(cancelTextDraft).toHaveBeenCalledOnce();
        expect(surface.editingId.value).toBeNull();
        expect(surface.handleEscape()).toBe(true);
        expect(surface.selectedIds.value.size).toBe(0);
        expect(onCreationCompleted).not.toHaveBeenCalled();
    });

    it('owns one text session and cancels a captured gesture before a tool change', () => {
        const { surface } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        const events: string[] = [];
        surface.registerPageInteraction(0, {
            commitTextDraft: () => {
                events.push('commit');
                surface.endTextEditing(box.identity.id, {restoreFocus: false});
            },
            cancelTextDraft: () => events.push('cancel-text'),
            cancelPointerGesture: () => events.push('cancel-pointer'),
            focus: () => events.push('focus'),
        });
        surface.beginTextEditing(box.identity.id);
        surface.beginPointerInteraction(0);
        surface.prepareToolChange();
        expect(events).toEqual([
            'commit',
            'cancel-pointer',
        ]);
        expect(surface.editingId.value).toBeNull();
        expect(surface.selectedIds.value.size).toBe(0);
        expect(surface.cancelActiveInteraction()).toBe(false);
    });

    it('suspends a hidden document by committing text and cancelling its gesture without tool completion', async () => {
        const {
            surface,
            onCreationCompleted,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        const focus = vi.fn();
        const cancelPointerGesture = vi.fn();
        const commitTextDraft = vi.fn(() => surface.endTextEditing(box.identity.id, {created: true}));
        surface.registerPageInteraction(0, {
            commitTextDraft,
            cancelTextDraft: vi.fn(),
            cancelPointerGesture,
            focus,
        });
        surface.beginTextEditing(box.identity.id);
        surface.beginPointerInteraction(0);
        surface.suspendInteraction();
        await Promise.resolve();
        expect(commitTextDraft).toHaveBeenCalledOnce();
        expect(cancelPointerGesture).toHaveBeenCalledOnce();
        expect(surface.selectedIds.value.has(box.identity.id)).toBe(true);
        expect(onCreationCompleted).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
    });

    it('applies explicit common properties to the whole canonical selection without changing defaults', () => {
        const {
            surface,
            annotationApplication,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        const note = surface.createNoteAt(0, rect);
        surface.select([
            box.identity.id,
            note.identity.id,
        ]);
        expect(surface.updateSelectedAnnotationProperties({color: '#123456'})).toBe(true);
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({color: '#123456'});
        expect(annotationApplication.value.store.get(note.identity.id)).toMatchObject({color: '#123456'});
        expect(surface.settings.value).toEqual(DEFAULT_ANNOTATION_SETTINGS);
    });

    it('does not mark unchanged font size and equal measured geometry as modified', () => {
        const {
            surface,
            emitAnnotationModified,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        surface.registerPageInteraction(0, {
            commitTextDraft: vi.fn(),
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
            fitTextBox: entity => ({...entity.rect}),
        });
        surface.select([box.identity.id]);
        emitAnnotationModified.mockClear();
        expect(surface.updateSelectedAnnotationProperties({fontSize: box.fontSize})).toBe(false);
        expect(emitAnnotationModified).not.toHaveBeenCalled();
    });

    it('keeps the requested input size while a text editor owns layout and fits completed styles natively', async () => {
        const {
            surface, annotationApplication,
        } = createSurfaceHarness({fitTextBox: async (_entity, proposal) => ({
            rect: proposal.rect,
            fontSize: 12.12,
        })});
        const box = surface.createTextBoxAt(0, rect, {text: 'Original'});
        surface.select([box.identity.id]);
        await surface.updateSelectedAnnotationProperties({fontSize: 18});
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({fontSize: 12.12});
        await surface.beginTextEditing(box.identity.id);
        surface.setTextBoxDraftPending(box.identity.id, 'Typing continues');
        await surface.updateSelectedAnnotationProperties({fontSize: 18});
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({
            fontSize: 18,
            text: 'Original',
            rect,
        });
        expect(surface.editingId.value).toBe(box.identity.id);
        expect(surface.hasTextBoxDraftPending(box.identity.id)).toBe(true);
        expect(surface.settings.value).toEqual(DEFAULT_ANNOTATION_SETTINGS);
    });

    it('saves the latest text and queued styles after completion closes the editor and a native style fit settles', async () => {
        const nativeFit = Promise.withResolvers<{
            rect: IAnnotationMarkerRect;
            fontSize: number
        }>();
        const fittingStarted = Promise.withResolvers<IAnnotationMarkerRect>();
        const {
            surface, annotationApplication,
        } = createSurfaceHarness({fitTextBox: async (_entity, proposal) => {
            fittingStarted.resolve(proposal.rect);
            return nativeFit.promise;
        }});
        const box = surface.createTextBoxAt(0, rect, {text: 'Original'});
        await surface.beginTextEditing(box.identity.id);
        const completion = Promise.withResolvers<undefined>();
        const completedRect = {
            ...rect,
            width: 0.3,
        };
        const accepted = completion.promise.then(() => {
            surface.commitGesture(box.identity.id, {
                text: 'Completed text',
                rect: completedRect,
            });
            surface.endTextEditing(box.identity.id, {restoreFocus: false});
        });
        const interaction = {
            commitTextDraft: () => accepted,
            get pendingTextCompletion() { return accepted; },
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
        };
        surface.registerPageInteraction(0, interaction);
        const color = surface.updateSelectedAnnotationProperties({color: '#f59e0b'});
        const size = surface.updateSelectedAnnotationProperties({fontSize: 18});
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({
            text: 'Original',
            color: box.color,
            fontSize: box.fontSize,
            rect,
        });
        completion.resolve(undefined);
        expect(await fittingStarted.promise).toEqual(completedRect);
        expect(surface.editingId.value).toBeNull();
        let saved: AnnotationEntity | null | undefined;
        const saving = Promise.resolve(surface.commitPendingTextBoxDraftsForSave()).then(() => {
            saved = annotationApplication.value.store.get(box.identity.id);
        });
        await Promise.resolve();
        expect(saved).toBeUndefined();
        nativeFit.resolve({
            rect: completedRect,
            fontSize: 12.12,
        });
        await Promise.all([
            color,
            size,
            saving,
        ]);
        expect(saved).toMatchObject({
            text: 'Completed text',
            color: '#f59e0b',
            fontSize: 12.12,
            rect: completedRect,
        });
    });

    it('contains a refused queued style while Save rejects and a later explicit Save commits the retained draft', async () => {
        const {
            surface, annotationApplication,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect, {text: 'Original'});
        await surface.beginTextEditing(box.identity.id);
        surface.setTextBoxDraftPending(box.identity.id, 'Retained latest text');
        const completion = Promise.withResolvers<undefined>();
        surface.registerPageInteraction(0, {
            pendingTextCompletion: completion.promise,
            commitTextDraft: () => {
                surface.commitGesture(box.identity.id, {text: 'Retained latest text'});
                surface.endTextEditing(box.identity.id, {restoreFocus: false});
            },
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
        });
        const command = surface.updateSelectedAnnotationProperties({color: '#f59e0b'});
        const saving = surface.commitPendingTextBoxDraftsForSave();
        const refused = expect(command).resolves.toBe(false);
        const rejectedSave = expect(saving).rejects.toThrow('The accepted paint failed');
        completion.reject(new Error('The accepted paint failed'));
        await Promise.all([
            refused,
            rejectedSave,
        ]);
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({
            text: 'Original',
            color: box.color,
        });
        expect(surface.editingId.value).toBe(box.identity.id);
        expect(surface.hasTextBoxDraftPending(box.identity.id)).toBe(true);
        await surface.commitPendingTextBoxDraftsForSave();
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({
            text: 'Retained latest text',
            color: box.color,
        });
        expect(surface.editingId.value).toBeNull();
        expect(surface.hasTextBoxDraftPending(box.identity.id)).toBe(false);
    });

    it('completes a live draft for Save after a queued style behind another viewer succeeds', async () => {
        const peerCompletion = Promise.withResolvers<undefined>();
        const {
            surface, annotationApplication,
        } = createSurfaceHarness({getPendingTextCompletion: () => peerCompletion.promise});
        const box = surface.createTextBoxAt(0, rect, {text: 'Original'});
        await surface.beginTextEditing(box.identity.id);
        surface.setTextBoxDraftPending(box.identity.id, 'Live latest text');
        surface.registerPageInteraction(0, {
            commitTextDraft: () => {
                surface.commitGesture(box.identity.id, {text: 'Live latest text'});
                surface.endTextEditing(box.identity.id, {restoreFocus: false});
            },
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
        });
        const command = surface.updateSelectedAnnotationProperties({color: '#f59e0b'});
        let saved: AnnotationEntity | null | undefined;
        const saving = Promise.resolve(surface.commitPendingTextBoxDraftsForSave()).then(() => {
            saved = annotationApplication.value.store.get(box.identity.id);
        });
        expect(saved).toBeUndefined();
        peerCompletion.resolve(undefined);
        await Promise.all([
            command,
            saving,
        ]);
        expect(saved).toMatchObject({
            text: 'Live latest text',
            color: '#f59e0b',
        });
        expect(surface.editingId.value).toBeNull();
        expect(surface.hasTextBoxDraftPending(box.identity.id)).toBe(false);
    });

    it('keeps inspector commands in linked views behind accepted text and style work through Save', async () => {
        const document = createPdfDocumentAnnotations({
            workingCopyPath: computed(() => requireDocumentRef('/managed/linked-style.pdf')),
            source: computed(() => null),
            documentRevisionToken: computed(() => null),
        });
        const nativeFit = Promise.withResolvers<{
            rect: IAnnotationMarkerRect;
            fontSize: number
        }>();
        const fittingStarted = Promise.withResolvers<undefined>();
        const left = createSurfaceHarness({
            annotationApplication: document.application,
            getPendingTextCompletion: document.getPendingTextCompletion,
            fitTextBox: async () => {fittingStarted.resolve(undefined); return nativeFit.promise;},
        }).surface;
        const right = createSurfaceHarness({
            annotationApplication: document.application,
            getPendingTextCompletion: document.getPendingTextCompletion,
        }).surface;
        for (const surface of [
            left,
            right,
        ]) document.attachView({
            emitAnnotationState: () => {},
            emitAnnotationModified: () => {},
            onHistoryReplay: () => {},
            commitPendingDraftsForSave: surface.commitPendingTextBoxDraftsForSave,
            getPendingTextCompletion: surface.getPendingTextCompletion,
            getTextBoxDraftRect: () => null,
        });
        const box = left.createTextBoxAt(0, rect, {text: 'Original'});
        await left.beginTextEditing(box.identity.id);
        right.select([box.identity.id]);
        const completion = Promise.withResolvers<undefined>();
        const accepted = completion.promise.then(() => {
            left.commitGesture(box.identity.id, {text: 'Completed in left'});
            left.endTextEditing(box.identity.id, {restoreFocus: false});
        });
        const interaction = {
            commitTextDraft: () => accepted,
            get pendingTextCompletion() { return accepted; },
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
        };
        left.registerPageInteraction(0, interaction);
        const color = right.updateSelectedAnnotationProperties({color: '#f59e0b'});
        const font = left.updateSelectedAnnotationProperties({fontSize: 18});
        expect(document.application.value.store.get(box.identity.id)).toMatchObject({
            text: 'Original',
            color: box.color,
            fontSize: box.fontSize,
        });
        completion.resolve(undefined);
        await fittingStarted.promise;
        expect(left.editingId.value).toBeNull();
        let savedText: string | undefined;
        const saving = document.commitPendingDraftsForSave().then(() => {
            const entity = document.application.value.store.get(box.identity.id);
            if (entity?.kind === 'text-box') savedText = entity.text;
        });
        await Promise.resolve();
        expect(savedText).toBeUndefined();
        nativeFit.resolve({
            rect,
            fontSize: 12.12,
        });
        await Promise.all([
            color,
            font,
            saving,
        ]);
        expect(savedText).toBe('Completed in left');
        expect(document.application.value.store.get(box.identity.id)).toMatchObject({
            text: 'Completed in left',
            color: '#f59e0b',
            fontSize: 12.12,
        });
    });

    it('changes live text properties synchronously without completing an unaccepted editor', async () => {
        const {
            surface, annotationApplication,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect, {text: 'Original'});
        await surface.beginTextEditing(box.identity.id);
        surface.setTextBoxDraftPending(box.identity.id, 'Typing continues');
        surface.registerPageInteraction(0, {
            commitTextDraft: () => {surface.endTextEditing(box.identity.id);},
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
        });
        expect(surface.updateSelectedAnnotationProperties({color: '#f59e0b'})).toBe(true);
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({
            text: 'Original',
            color: '#f59e0b',
        });
        expect(surface.editingId.value).toBe(box.identity.id);
        expect(surface.hasTextBoxDraftPending(box.identity.id)).toBe(true);
    });

    it('rejects font and geometry together when text cannot fit the page', () => {
        const {
            surface,
            annotationApplication,
            emitAnnotationModified,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        surface.registerPageInteraction(0, {
            commitTextDraft: vi.fn(),
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
            fitTextBox: () => null,
        });
        surface.select([box.identity.id]);
        emitAnnotationModified.mockClear();
        expect(surface.updateSelectedAnnotationProperties({fontSize: 72})).toBe(false);
        expect(annotationApplication.value.store.get(box.identity.id)).toEqual(box);
        expect(emitAnnotationModified).not.toHaveBeenCalled();
    });

    it('fits selected text to a new font size before one canonical update', () => {
        const {
            surface,
            annotationApplication,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        const fitTextBox = vi.fn(() => ({
            ...rect,
            height: 0.15,
        }));
        surface.registerPageInteraction(0, {
            commitTextDraft: vi.fn(),
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
            fitTextBox,
        });
        surface.select([box.identity.id]);
        const before = annotationApplication.value.store.get(box.identity.id)!.revision;
        surface.updateSelectedAnnotationProperties({fontSize: 32});
        expect(fitTextBox).toHaveBeenCalledWith(expect.objectContaining({fontSize: 32}));
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({
            fontSize: 32,
            rect: {
                ...rect,
                height: 0.15,
            },
            revision: before + 1,
        });
    });

    it('clears a moving page preview when its interaction host unmounts', () => {
        const {surface} = createSurfaceHarness();
        const cancelPointerGesture = vi.fn();
        const interaction = {
            commitTextDraft: vi.fn(),
            cancelTextDraft: vi.fn(),
            cancelPointerGesture,
            focus: vi.fn(),
        };
        const unregisterMovingPage = surface.registerPageInteraction(0, interaction);
        const unregisterOtherPage = surface.registerPageInteraction(1, {
            ...interaction,
            cancelPointerGesture: vi.fn(),
        });
        surface.beginPointerInteraction(0);
        surface.setSelectionMoveDelta({
            x: 0.1,
            y: 0.2,
        });
        unregisterOtherPage();
        expect(surface.selectionMoveDelta.value).toEqual({
            x: 0.1,
            y: 0.2,
        });
        expect(cancelPointerGesture).not.toHaveBeenCalled();
        unregisterMovingPage();
        expect(surface.selectionMoveDelta.value).toBeNull();
        expect(cancelPointerGesture).toHaveBeenCalledOnce();
        expect(surface.cancelActiveInteraction()).toBe(false);
    });

    it('clears the shared selection preview when its pointer operation ends or cancels', () => {
        const {surface} = createSurfaceHarness();
        surface.beginPointerInteraction(0);
        surface.setSelectionMoveDelta({
            x: 0.1,
            y: 0.2,
        });
        surface.endPointerInteraction(1);
        expect(surface.selectionMoveDelta.value).toEqual({
            x: 0.1,
            y: 0.2,
        });
        surface.endPointerInteraction(0);
        expect(surface.selectionMoveDelta.value).toBeNull();
        surface.beginPointerInteraction(0);
        surface.setSelectionMoveDelta({
            x: 0.2,
            y: 0.1,
        });
        surface.cancelActiveInteraction();
        expect(surface.selectionMoveDelta.value).toBeNull();
    });

    afterEach(() => {
        for (const scope of activeScopes) {
            scope.stop();
        }
        activeScopes.clear();
    });

    it('projects every authored kind from the store and preserves markup subtypes and geometry', () => {
        const harness = createSurfaceHarness();
        const { store } = harness.annotationApplication.value;
        const entities: AnnotationEntity[] = [
            {
                kind: 'text-box',
                ...baseEntity('text-box'),
                text: 'text box',
                rect,
                rotation: 0,
                fontSize: 18,
                color: '#111827',
            },
            {
                kind: 'note',
                ...baseEntity('note'),
                contents: 'note',
                position: {
                    ...rect,
                    width: 0.018,
                    height: 0.018,
                },
                color: '#f59e0b',
                open: false,
            },
            {
                kind: 'placed-image',
                ...baseEntity('placed-image'),
                rect,
                rotation: 0,
                image: {
                    objectNumber: 10,
                    generationNumber: 0,
                    byteLength: 4,
                    sha256: 'a'.repeat(64),
                },
            },
            {
                kind: 'text-markup',
                ...baseEntity('text-markup'),
                subtype: 'Underline',
                contents: 'markup note',
                quadPoints: [
                    rect,
                    {
                        ...rect,
                        top: 0.3,
                    },
                ],
                color: '#2563eb',
                opacity: 0.8,
                selectedText: 'underlined text',
            },
            {
                kind: 'shape',
                ...baseEntity('shape'),
                tool: 'rectangle',
                rect,
                strokeColor: '#dc2626',
                strokeWidth: 2,
                fill: null,
                opacity: 1,
            },
        ];

        entities.forEach((entity) => {
            switch (entity.kind) {
                case 'text-box':
                    store.createTextBox(entity);
                    break;
                case 'note':
                    store.createNote(entity);
                    break;
                case 'placed-image':
                    store.createPlacedImage(entity);
                    break;
                case 'text-markup':
                    store.createTextMarkup(entity);
                    break;
                case 'shape':
                    store.createShape(entity);
                    break;
            }
        });

        const projected = harness.surface.getEntitiesForPage(0);
        expect(projected.map(entity => entity.kind)).toEqual([
            'text-box',
            'note',
            'placed-image',
            'text-markup',
            'shape',
        ]);
        const markup = projected.find((entity) => entity.kind === 'text-markup');
        expect(markup).toMatchObject({
            kind: 'text-markup',
            subtype: 'Underline',
            quadPoints: [
                rect,
                {
                    ...rect,
                    top: 0.3,
                },
            ],
            selectedText: 'underlined text',
        });

        harness.surface.select([asAnnotationId('text-markup')]);
        harness.surface.select([asAnnotationId('shape')], {additive: true});
        expect(harness.surface.selectedIds.value).toEqual(new Set([
            asAnnotationId('text-markup'),
            asAnnotationId('shape'),
        ]));

        harness.stop();
    });

    it('removes tombstoned entities from the page projection', () => {
        const harness = createSurfaceHarness();
        const entity = {
            kind: 'note' as const,
            ...baseEntity('deleted-note'),
            contents: '',
            position: rect,
            color: null,
            open: false,
        };
        harness.annotationApplication.value.store.createNote(entity);
        expect(harness.surface.getEntitiesForPage(0)).toHaveLength(1);

        harness.annotationApplication.value.store.delete(entity.identity.id);

        expect(harness.surface.getEntitiesForPage(0)).toEqual([]);
        harness.stop();
    });

    it('forwards canonical shape context-menu selection to the workspace bridge', () => {
        const harness = createSurfaceHarness();
        const entity = {
            kind: 'shape' as const,
            ...baseEntity('context-shape'),
            tool: 'rectangle' as const,
            rect,
            strokeColor: '#dc2626',
            strokeWidth: 2,
            fill: null,
            opacity: 1,
        };
        harness.annotationApplication.value.store.createShape(entity);

        harness.surface.openShapeContextMenu({
            shapeId: entity.identity.id,
            clientX: 120,
            clientY: 240,
        });

        expect(harness.emitShapeContextMenu).toHaveBeenCalledWith({
            shapeId: entity.identity.id,
            clientX: 120,
            clientY: 240,
        });
        harness.stop();
    });

    it('uses the selected subtype settings when creating text markup directly', () => {
        const harness = createSurfaceHarness();

        const created = harness.surface.createHighlightFromSelection(0, [rect], {subtype: 'Underline'});

        expect(created).toMatchObject({
            subtype: 'Underline',
            color: DEFAULT_ANNOTATION_SETTINGS.underlineColor,
            opacity: DEFAULT_ANNOTATION_SETTINGS.underlineOpacity,
        });
        harness.stop();
    });

    it('refreshes a merged highlight preview from its resolved union geometry', () => {
        const harness = createSurfaceHarness();
        const first = harness.surface.createHighlightFromSelection(0, [rect], {selectedText: 'first text'});
        const resolveSelectedText = vi.fn((quadPoints) => {
            expect(quadPoints).toEqual([{
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.05,
            }]);
            return 'first and second text';
        });

        const merged = harness.surface.createHighlightFromSelection(0, [{
            ...rect,
            left: 0.2,
        }], {selectedText: 'second text'}, {resolveSelectedText});

        expect(merged.identity.id).toBe(first.identity.id);
        expect(resolveSelectedText).toHaveBeenCalledOnce();
        expect(harness.annotationApplication.value.store.get(first.identity.id)).toMatchObject({selectedText: 'first and second text'});
        harness.stop();
    });

    it('keeps a partial overlap preview through merge undo and redo', () => {
        const harness = createSurfaceHarness();
        const first = harness.surface.createHighlightFromSelection(0, [{
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.05,
        }], {selectedText: 'AB'});
        const resolveSelectedText = vi.fn((quadPoints) => {
            expect(quadPoints).toEqual([{
                left: 0.1,
                top: 0.2,
                width: 0.45,
                height: 0.05,
            }]);
            return 'ABC';
        });

        const merged = harness.surface.createHighlightFromSelection(0, [{
            left: 0.25,
            top: 0.2,
            width: 0.3,
            height: 0.05,
        }], {selectedText: 'BC'}, {resolveSelectedText});

        expect(merged.identity.id).toBe(first.identity.id);
        expect(harness.annotationApplication.value.store.get(first.identity.id)).toMatchObject({selectedText: 'ABC'});
        expect(harness.surface.undo()).toBe(true);
        expect(harness.annotationApplication.value.store.get(first.identity.id)).toMatchObject({selectedText: 'AB'});
        expect(harness.surface.redo()).toBe(true);
        expect(harness.annotationApplication.value.store.get(first.identity.id)).toMatchObject({selectedText: 'ABC'});
        harness.stop();
    });

    it('creates and selects one canonical stamp with its JPEG image reference', () => {
        const harness = createSurfaceHarness();
        const image = {
            objectNumber: 17,
            generationNumber: 0,
            byteLength: 4,
            sha256: 'b'.repeat(64),
        };

        const created = harness.surface.createStampAt(1, rect, image);

        expect(created).toMatchObject({
            kind: 'placed-image',
            pageIndex: requirePageIndex(1),
            rect,
            rotation: 0,
            image,
        });
        expect(harness.annotationApplication.value.store.list()).toEqual([created]);
        harness.surface.select([created.identity.id]);
        expect(harness.surface.selectedIds.value).toEqual(new Set([created.identity.id]));

        harness.stop();
    });

    it('creates, selects, styles, and deletes a text box through the canonical surface', () => {
        const harness = createSurfaceHarness();

        const created = harness.surface.createTextBoxAt(0, rect);
        expect(harness.emitAnnotationModified).not.toHaveBeenCalled();
        harness.surface.select([created.identity.id]);

        expect(harness.surface.getSelectedTextBox()).toMatchObject({
            identity: created.identity,
            rect,
            fontSize: DEFAULT_ANNOTATION_SETTINGS.textSize,
            color: DEFAULT_ANNOTATION_SETTINGS.textColor,
        });
        // The inspector reads the reactive selection; it must follow the edit.
        expect(harness.surface.selectedTextBox.value?.fontSize).toBe(DEFAULT_ANNOTATION_SETTINGS.textSize);
        expect(harness.surface.updateSelectedAnnotationProperties({
            fontSize: 22,
            color: '#ef4444',
        })).toBe(true);
        expect(harness.emitAnnotationModified).toHaveBeenCalledOnce();
        expect(harness.surface.getSelectedTextBox()).toMatchObject({
            fontSize: 22,
            color: '#ef4444',
        });
        expect(harness.surface.selectedAnnotations.value).toMatchObject([{
            fontSize: 22,
            color: '#ef4444',
        }]);
        expect(harness.surface.selectedTextBox.value?.fontSize).toBe(22);
        expect(harness.surface.updateSelectedAnnotationProperties({fontSize: 22})).toBe(false);
        expect(harness.surface.deleteAnnotation(created.identity.id)).toBe(true);
        expect(harness.surface.getSelectedTextBox()).toBeNull();
        expect(harness.surface.selectedTextBox.value).toBeNull();
        expect(harness.emitAnnotationModified).toHaveBeenCalledTimes(2);

        harness.stop();
    });

    it('keeps the editor and its draft pending until the owning page completes protection', async () => {
        const harness = createSurfaceHarness();
        const box = harness.surface.createTextBoxAt(0, rect, {text: 'Before'});
        harness.surface.beginTextEditing(box.identity.id);
        harness.surface.setTextBoxDraftPending(box.identity.id, 'Accepted after protection');
        const protection = Promise.withResolvers<undefined>();
        const unregister = harness.surface.registerPageInteraction(0, {
            commitTextDraft: async () => {
                await protection.promise;
                harness.surface.commitGesture(box.identity.id, {text: 'Accepted after protection'});
                harness.surface.endTextEditing(box.identity.id);
            },
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
        });
        const saving = harness.surface.commitPendingTextBoxDraftsForSave();
        expect(harness.surface.getEntitiesForPage(0)[0]).toMatchObject({text: 'Before'});
        expect(harness.surface.editingId.value).toBe(box.identity.id);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(true);
        protection.resolve(undefined);
        await saving;
        expect(harness.surface.getEntitiesForPage(0)[0]).toMatchObject({text: 'Accepted after protection'});
        expect(harness.surface.editingId.value).toBeNull();
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);
        unregister();
        harness.stop();
    });

    it('publishes every live text draft without committing it, then retracts it on cancel', () => {
        const harness = createSurfaceHarness();
        const entity = harness.surface.createTextBoxAt(0, rect, {text: 'Original'});
        harness.surface.beginTextEditing(entity.identity.id);
        const epoch = harness.annotationApplication.value.store.mutationEpoch;

        harness.surface.setTextBoxDraftPending(entity.identity.id, 'First');
        harness.surface.setTextBoxDraftPending(entity.identity.id, 'Текст العربية');
        harness.surface.setTextBoxDraftPending(entity.identity.id, '');
        expect(harness.onTextBoxDraftChanged.mock.calls).toEqual([
            [
                entity.identity.id,
                'First',
            ],
            [
                entity.identity.id,
                'Текст العربية',
            ],
            [
                entity.identity.id,
                '',
            ],
        ]);
        expect(harness.annotationApplication.value.listCommentSummaries()[0]?.text).toBe('Original');
        expect(harness.annotationApplication.value.store.mutationEpoch).toBe(epoch);

        harness.surface.endTextEditing(entity.identity.id, {cancelled: true});
        expect(harness.onTextBoxDraftChanged).toHaveBeenLastCalledWith(entity.identity.id, null);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);
    });

    it('keeps browser input out of its own raster while peer paint follows draft text and geometry', async () => {
        const drafts = shallowReactive(new Map<string, string>());
        const draftRects = shallowReactive(new Map<string, IAnnotationMarkerRect>());
        const shared = {
            getTextBoxDraftText: (id: string) => drafts.get(id) ?? null,
            textBoxDraftRects: draftRects,
            onTextBoxDraftChanged: (id: string, text: string | null) => {if (text === null) drafts.delete(id); else drafts.set(id, text);},
        };
        const owner = createSurfaceHarness(shared);
        const peer = createSurfaceHarness({
            ...shared,
            annotationApplication: owner.annotationApplication,
        });
        const box = owner.surface.createTextBoxAt(0, rect, {text: 'Original'});
        const measured = {
            ...rect,
            height: 0.12,
        };
        owner.surface.registerPageInteraction(0, {
            commitTextDraft: () => {},
            cancelTextDraft: () => {},
            cancelPointerGesture: () => {},
            focus: () => {},
            getTextBoxDraftRect: () => measured,
        });
        await owner.surface.beginTextEditing(box.identity.id);
        owner.surface.setTextBoxDraftPending(box.identity.id, 'First');
        expect(owner.surface.getPaintInput(box)).toMatchObject({
            text: 'Original',
            rect,
        });
        expect(peer.surface.getPaintInput(box)).toMatchObject({
            text: 'First',
            rect: measured,
        });
        owner.surface.setTextBoxDraftPending(box.identity.id, 'Second');
        expect(owner.surface.getPaintInput(box)).toMatchObject({
            text: 'Original',
            rect,
        });
        expect(peer.surface.getPaintInput(box)).toMatchObject({
            text: 'Second',
            rect: measured,
        });
        expect(owner.annotationApplication.value.store.get(box.identity.id)).toMatchObject({
            text: 'Original',
            rect,
        });
        owner.surface.endTextEditing(box.identity.id, {cancelled: true});
        expect(peer.surface.getPaintInput(box)).toMatchObject({
            text: 'Original',
            rect,
        });
    });

    it.each([
        true,
        false,
    ])('keeps document work when the whole editor scope closes during protection (accepted: %s)', async accepted => {
        const document = createPdfDocumentAnnotations({
            workingCopyPath: computed(() => requireDocumentRef('/managed/shared.pdf')),
            source: computed(() => null),
            documentRevisionToken: computed(() => null),
        });
        const scope = effectScope();
        activeScopes.add(scope);
        const protection = Promise.withResolvers<undefined>();
        const surface = scope.run(() => usePdfAnnotationEditorSurface({
            annotationApplication: document.application,
            activeTool: computed(() => 'text'),
            settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            onTextBoxDraftChanged: document.setTextBoxDraft,
            textBoxDraftRects: document.textBoxDraftRects,
            getTextBoxDraftText: id => document.textBoxDrafts.get(id) ?? null,
            getTextBoxDraftGeneration: id => document.textBoxDraftGenerations.get(id),
            protectTextBoxDraft: () => protection.promise,
        }))!;
        const box = surface.createTextBoxAt(0, rect, {text: 'Before'});
        await surface.beginTextEditing(box.identity.id);
        surface.setTextBoxDraftPending(box.identity.id, 'Retained after viewer disposal');
        const draftRect = {
            ...rect,
            width: 0.5,
        };
        surface.registerPageInteraction(0, {
            commitTextDraft: async () => {
                await surface.protectTextBoxDraft(box.identity.id);
                surface.commitGesture(box.identity.id, {
                    text: 'Retained after viewer disposal',
                    rect: draftRect,
                });
                surface.endTextEditing(box.identity.id);
            },
            cancelTextDraft: () => {},
            cancelPointerGesture: () => {},
            focus: () => {},
            getTextBoxDraftRect: () => draftRect,
        });
        const saving = surface.commitPendingTextBoxDraftsForSave();
        const rejected = accepted ? null : expect(saving).rejects.toThrow('ENOSPC');
        scope.stop();
        expect.soft(document.textBoxDrafts.get(box.identity.id)).toBe('Retained after viewer disposal');
        expect(document.getTextBoxDraftRect(box.identity.id)).toEqual(draftRect);
        if (accepted) {
            protection.resolve(undefined);
            await saving;
            expect(document.application.value.store.get(box.identity.id)).toMatchObject({
                text: 'Retained after viewer disposal',
                rect: draftRect,
            });
            expect(document.textBoxDrafts.size).toBe(0);
        } else {
            protection.reject(new Error('ENOSPC'));
            await rejected;
            expect(document.application.value.store.get(box.identity.id)).toMatchObject({
                text: 'Before',
                rect,
            });
            expect(document.textBoxDrafts.get(box.identity.id)).toBe('Retained after viewer disposal');
            await expect(document.commitPendingDraftsForSave()).rejects.toThrow('Missing required text draft editor');
        }
    });

    it('reports pending text box drafts until the editor commits or cancels them', () => {
        const harness = createSurfaceHarness();
        const annotationId = asAnnotationId('pending-text-box');
        harness.annotationApplication.value.store.createTextBox({
            kind: 'text-box',
            ...baseEntity(annotationId),
            text: '',
            rect,
            rotation: 0,
            fontSize: 14,
            color: '#111827',
        });

        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);
        harness.surface.setTextBoxDraftPending(annotationId);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(true);

        // Repeated input events for one editor must not inflate the count.
        harness.surface.setTextBoxDraftPending(annotationId);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(true);

        harness.surface.clearTextBoxDraftPending(annotationId);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);
        harness.surface.clearTextBoxDraftPending(annotationId);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);

        harness.surface.setTextBoxDraftPending(annotationId);
        harness.annotationApplication.value = new AnnotationApplication('surface-next-document');
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);

        harness.stop();
    });

    it('ignores stale draft input for an id that is absent from the current document', () => {
        const harness = createSurfaceHarness();

        harness.surface.setTextBoxDraftPending(asAnnotationId('stale-text-box'));

        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);
        harness.stop();
    });

    it('prunes pending drafts when text boxes are discarded or deleted', () => {
        const harness = createSurfaceHarness();
        const createTextBox = (id: string) => harness.annotationApplication.value.store.createTextBox({
            kind: 'text-box',
            ...baseEntity(id),
            text: '',
            rect,
            rotation: 0,
            fontSize: 14,
            color: '#111827',
        });
        const markPending = (id: string) => harness.surface.setTextBoxDraftPending(asAnnotationId(id));

        const discarded = createTextBox('discarded-pending-text-box');
        const discardUnrelated = createTextBox('discard-unrelated-pending-text-box');
        markPending(discarded.identity.id);
        markPending(discardUnrelated.identity.id);
        expect(harness.surface.discardUnsavedAnnotation(discarded.identity.id)).toBe(true);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(true);
        harness.surface.clearTextBoxDraftPending(discardUnrelated.identity.id);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);

        const deleted = createTextBox('deleted-pending-text-box');
        const deleteUnrelated = createTextBox('delete-unrelated-pending-text-box');
        markPending(deleted.identity.id);
        markPending(deleteUnrelated.identity.id);
        expect(harness.surface.deleteAnnotation(deleted.identity.id)).toBe(true);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(true);
        harness.surface.clearTextBoxDraftPending(deleteUnrelated.identity.id);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);

        const selected = createTextBox('selection-pending-text-box');
        const selectionUnrelated = createTextBox('selection-unrelated-pending-text-box');
        markPending(selected.identity.id);
        markPending(selectionUnrelated.identity.id);
        harness.surface.select([selected.identity.id]);
        harness.surface.deleteSelection();
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(true);
        harness.surface.clearTextBoxDraftPending(selectionUnrelated.identity.id);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);

        harness.stop();
    });

    it('discards a never-saved text box without leaving a tombstone or undo command', () => {
        const harness = createSurfaceHarness();
        const created = harness.surface.createTextBoxAt(0, rect);

        expect(harness.surface.discardUnsavedAnnotation(created.identity.id)).toBe(true);
        expect(harness.emitAnnotationModified).not.toHaveBeenCalled();
        expect(harness.annotationApplication.value.store.get(created.identity.id)).toBeNull();
        expect(harness.annotationApplication.value.store.canUndo).toBe(false);
        expect(harness.surface.discardUnsavedAnnotation(created.identity.id)).toBe(false);

        harness.stop();
    });
});
