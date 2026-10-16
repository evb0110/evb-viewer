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
    ref,
} from 'vue';
import type {
    IAnnotationGesture,
    IAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type { INoteEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { useAnnotationPointerGesture } from '@app/modules/pdf-viewer/annotations/editor/useAnnotationPointerGesture';
import {requirePageIndex} from '@contracts/pageNumbers';

const gesture: IAnnotationGesture = {
    annotationId: 'text-box' as IAnnotationGesture['annotationId'],
    entity: {
        kind: 'text-box',
        identity: {id: 'text-box' as IAnnotationGesture['annotationId']},
        pageIndex: requirePageIndex(0),
        revision: 1,
        persistedRevision: 1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        text: 'hello',
        rect: {
            left: 0.2,
            top: 0.3,
            width: 0.4,
            height: 0.2,
        },
        rotation: 0,
        fontSize: 14,
        color: '#111827',
    },
    kind: 'move',
};

const noteGesture: IAnnotationGesture = {
    ...gesture,
    annotationId: 'note' as IAnnotationGesture['annotationId'],
    entity: {
        kind: 'note',
        identity: {id: 'note' as INoteEntity['identity']['id']},
        pageIndex: requirePageIndex(0),
        revision: 1,
        persistedRevision: 1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        contents: 'note',
        position: {
            left: 0.2,
            top: 0.3,
            width: 0.4,
            height: 0.2,
        },
        color: '#111827',
        open: false,
    },
};

function expectRectClose(
    actual: {
        left: number;
        top: number;
        width: number;
        height: number
    } | null,
    expected: {
        left: number;
        top: number;
        width: number;
        height: number
    },
) {
    expect(actual).not.toBeNull();
    expect(actual!.left).toBeCloseTo(expected.left);
    expect(actual!.top).toBeCloseTo(expected.top);
    expect(actual!.width).toBeCloseTo(expected.width);
    expect(actual!.height).toBeCloseTo(expected.height);
}

function pointer(clientX: number, clientY: number, pointerId = 1) {
    return {
        clientX,
        clientY,
        pointerId,
    };
}

function createHarness(scopes: Set<ReturnType<typeof effectScope>>) {
    const scope = effectScope();
    scopes.add(scope);
    const selectedIds = ref(new Set([gesture.annotationId]));
    const surfaceMethods: Pick<IAnnotationEditorSurface, 'beginMove' | 'beginResize' | 'entitiesByPage' | 'movingIds' | 'getPageGeometry'> = {
        entitiesByPage: computed(() => new Map([[
            0,
            [gesture.entity],
        ]])),
        movingIds: computed(() => selectedIds.value),
        getPageGeometry: () => ({
            pageView: [
                0,
                0,
                612,
                792,
            ],
            rotation: 0,
        }),
        beginMove: vi.fn(() => gesture),
        beginResize: vi.fn(() => ({
            ...gesture,
            kind: 'resize' as const,
        })),
    };
    const surface = {...surfaceMethods} as IAnnotationEditorSurface;
    const interaction = scope.run(() => useAnnotationPointerGesture({
        surface,
        pageIndex: requirePageIndex(0),
    }))!;
    return {
        scope,
        surface,
        interaction,
        selectedIds,
    };
}

describe('useAnnotationPointerGesture', () => {
    const scopes = new Set<ReturnType<typeof effectScope>>();

    afterEach(() => {
        scopes.forEach(scope => scope.stop());
        scopes.clear();
    });

    it('previews a create drag and returns the final rectangle without writing during movement', () => {
        const harness = createHarness(scopes);

        expect(harness.interaction.beginCreate({
            x: 0.2,
            y: 0.3,
        }, pointer(20, 30))).toBe(true);
        harness.interaction.update({
            x: 0.6,
            y: 0.7,
        }, pointer(60, 70));

        expectRectClose(harness.interaction.previewRect.value, {
            left: 0.2,
            top: 0.3,
            width: 0.4,
            height: 0.4,
        });
        const completion = harness.interaction.finish({
            x: 0.6,
            y: 0.7,
        }, pointer(60, 70));
        expect(completion).toMatchObject({
            mode: 'create',
            hasMoved: true,
        });
        expectRectClose(completion?.rect ?? null, {
            left: 0.2,
            top: 0.3,
            width: 0.4,
            height: 0.4,
        });
        expect(harness.surface.beginMove).not.toHaveBeenCalled();
    });

    it('keeps a click-create distinct from a drag so the caller can use the default box', () => {
        const harness = createHarness(scopes);

        harness.interaction.beginCreate({
            x: 0.4,
            y: 0.5,
        }, pointer(40, 50));

        const completion = harness.interaction.finish({
            x: 0.41,
            y: 0.5,
        }, pointer(41, 50));
        expect(completion).toMatchObject({
            mode: 'create',
            hasMoved: false,
        });
        expectRectClose(completion?.rect ?? null, {
            left: 0.4,
            top: 0.5,
            width: 0.01,
            height: 0.01,
        });
    });

    it('previews and completes a move from the captured text-box entity', () => {
        const harness = createHarness(scopes);

        expect(harness.interaction.beginMove(gesture.annotationId, {
            x: 0.3,
            y: 0.4,
        }, pointer(30, 40))).toBe(true);
        harness.interaction.update({
            x: 0.5,
            y: 0.1,
        }, pointer(50, 10));

        expect(harness.interaction.previewRect.value).toMatchObject({
            left: 0.4,
            top: 0,
            width: 0.4,
            height: 0.2,
        });
        expect(harness.interaction.finish({
            x: 0.5,
            y: 0.1,
        }, pointer(50, 10))).toMatchObject({
            mode: 'move',
            gesture,
            hasMoved: true,
        });
        expect(harness.surface.beginMove).toHaveBeenCalledWith(gesture.annotationId);
    });

    it('previews and completes a move from the canonical note position', () => {
        const harness = createHarness(scopes);
        harness.surface.beginMove = vi.fn(() => noteGesture);

        expect(harness.interaction.beginMove(noteGesture.annotationId, {
            x: 0.3,
            y: 0.4,
        }, pointer(30, 40))).toBe(true);
        harness.interaction.update({
            x: 0.5,
            y: 0.1,
        }, pointer(50, 10));

        expect(harness.interaction.previewRect.value).toMatchObject({
            left: 0.4,
            top: 0,
            width: 0.4,
            height: 0.2,
        });
        expect(harness.interaction.finish({
            x: 0.5,
            y: 0.1,
        }, pointer(50, 10))).toMatchObject({
            mode: 'move',
            gesture: noteGesture,
            hasMoved: true,
        });
    });

    it('keeps deliberate drag creation when the pointer returns to its starting point', () => {
        const harness = createHarness(scopes);
        harness.interaction.beginCreate({
            x: 0.2,
            y: 0.2,
        }, pointer(20, 20));
        harness.interaction.update({
            x: 0.4,
            y: 0.4,
        }, pointer(40, 40));
        expect(harness.interaction.hasMoved.value).toBe(true);
        const completion = harness.interaction.finish({
            x: 0.2,
            y: 0.2,
        }, pointer(20, 20));
        expect(completion?.hasMoved).toBe(true);
    });

    it('cancels the active gesture and clears its preview', () => {
        const harness = createHarness(scopes);

        harness.interaction.beginResize(gesture.annotationId, 'se', {
            x: 0.6,
            y: 0.5,
        }, pointer(60, 50));
        expect(harness.interaction.isActive.value).toBe(true);
        harness.interaction.cancel();

        expect(harness.interaction.isActive.value).toBe(false);
        expect(harness.interaction.previewRect.value).toBeNull();
    });

    it('releases the pointer while retaining its proposal until that accepted gesture settles', () => {
        const {interaction} = createHarness(scopes);
        interaction.beginResize(gesture.annotationId, 'se', {
            x: 0.6,
            y: 0.5,
        }, pointer(60, 50));
        const first = interaction.finish({
            x: 0.8,
            y: 0.7,
        }, pointer(80, 70))!;
        expect(interaction.isActive.value).toBe(false);
        expect(interaction.isActiveForPointer(1)).toBe(false);
        expectRectClose(interaction.previewRect.value, first.rect);
        expect(interaction.beginResize(gesture.annotationId, 'e', {
            x: 0.8,
            y: 0.5,
        }, pointer(80, 50, 2))).toBe(true);
        interaction.update({
            x: 0.5,
            y: 0.5,
        }, pointer(50, 50, 2));
        const nextPreview = interaction.previewRect.value;
        expect(interaction.cancel(first.gesture)).toBe(false);
        expectRectClose(interaction.previewRect.value, nextPreview!);
        const second = interaction.finish({
            x: 0.5,
            y: 0.5,
        }, pointer(50, 50, 2))!;
        expect(interaction.cancel(second.gesture)).toBe(true);
        expect(interaction.previewRect.value).toBeNull();
    });

    it('retains the released move cohort when later input changes the selection', () => {
        const {
            interaction, selectedIds,
        } = createHarness(scopes);
        interaction.beginMove(gesture.annotationId, {
            x: 0.3,
            y: 0.4,
        }, pointer(30, 40));
        const completed = interaction.finish({
            x: 0.4,
            y: 0.5,
        }, pointer(40, 50))!;
        selectedIds.value = new Set([noteGesture.annotationId]);
        expect(interaction.movingIds.value).toEqual(new Set([gesture.annotationId]));
        expectRectClose(interaction.previewRect.value, completed.rect);
        interaction.cancel(completed.gesture);
        expect(interaction.movingIds.value.size).toBe(0);
    });

    it('keeps a newer text selection when the previous released preview settles', () => {
        const {interaction} = createHarness(scopes);
        interaction.beginMove(gesture.annotationId, {
            x: 0.3,
            y: 0.4,
        }, pointer(30, 40));
        const completed = interaction.finish({
            x: 0.4,
            y: 0.5,
        }, pointer(40, 50))!;
        expect(interaction.beginTextSelection(pointer(50, 50, 2))).toBe(true);
        interaction.cancel(completed.gesture);
        expect(interaction.isTextSelecting.value).toBe(true);
        expect(interaction.finishTextSelection(pointer(80, 50, 2))).toMatchObject({hasMoved: true});
        expect(interaction.isTextSelecting.value).toBe(false);
    });
});
