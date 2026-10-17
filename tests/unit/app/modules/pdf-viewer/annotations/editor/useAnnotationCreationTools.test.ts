import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IPlacedImageEntity,
    INoteEntity,
    ITextBoxEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { toLegacyShapeAnnotation } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { isNativeShapeEligible } from '@app/modules/pdf-viewer/runtime/save/nativeShapeMutations';
import type { IAnnotationEditorSurface } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import { useAnnotationCreationTools } from '@app/modules/pdf-viewer/annotations/editor/useAnnotationCreationTools';
import {computed} from 'vue';
import {requirePageIndex} from '@contracts/pageNumbers';
import type {TDrawableShapeType} from '@app/types/annotations';

const entity = {
    kind: 'text-box',
    identity: {id: 'text-box' as ITextBoxEntity['identity']['id']},
    pageIndex: requirePageIndex(2),
    revision: 0,
    persistedRevision: -1,
    deleted: false,
    createdAt: null,
    modifiedAt: null,
    author: null,
    text: '',
    rect: {
        left: 0.2,
        top: 0.3,
        width: 0.4,
        height: 0.2,
    },
    rotation: 0,
    fontSize: 14,
    color: '#111827',
} satisfies ITextBoxEntity;

const note = {
    kind: 'note',
    identity: {id: 'note' as INoteEntity['identity']['id']},
    pageIndex: requirePageIndex(2),
    revision: 0,
    persistedRevision: -1,
    deleted: false,
    createdAt: null,
    modifiedAt: null,
    author: null,
    contents: '',
    position: entity.rect,
    color: '#111827',
    open: false,
} satisfies INoteEntity;

const stamp = {
    kind: 'placed-image',
    identity: {id: 'stamp' as IPlacedImageEntity['identity']['id']},
    pageIndex: requirePageIndex(2),
    revision: 0,
    persistedRevision: -1,
    deleted: false,
    createdAt: null,
    modifiedAt: null,
    author: null,
    rect: entity.rect,
    rotation: 0,
    image: {
        objectNumber: 10,
        generationNumber: 0,
        byteLength: 4,
        sha256: 'a'.repeat(64),
    },
} satisfies IPlacedImageEntity;

function drawThrough(
    tools: ReturnType<typeof useAnnotationCreationTools>,
    tool: TDrawableShapeType,
    [
        origin,
        ...points
    ]: Array<{
        x: number;
        y: number
    }
    >,
) {
    let draft = tools.beginShape(0, tool, origin!)!;
    for (const point of points) draft = tools.updateShape(draft, point, origin!);
    return draft;
}

describe('useAnnotationCreationTools', () => {
    it.each([
        'rectangle',
        'circle',
    ] as const)('keeps the original %s anchor through reverse drag and duplicate release', tool => {
        const tools = useAnnotationCreationTools({surface: {settings: computed(() => null)} as IAnnotationEditorSurface});
        const origin = {
            x: 0.8,
            y: 0.8,
        };
        let draft = tools.beginShape(0, tool, origin)!;
        for (const value of [
            0.6,
            0.4,
            0.4,
        ]) draft = tools.updateShape(draft, {
            x: value,
            y: value,
        }, origin);
        const created = tools.finishShape(draft);
        expect(created?.rect).toEqual({
            left: 0.4,
            top: 0.4,
            width: 0.4,
            height: 0.4,
        });
    });

    it.each([
        'rectangle',
        'circle',
        'line',
        'arrow',
        'draw',
    ] as const)('keeps a %s dragged past the page edge saveable', tool => {
        const tools = useAnnotationCreationTools({surface: {settings: computed(() => null)} as IAnnotationEditorSurface});
        const origin = {
            x: 0.1,
            y: 0.72,
        };
        // A captured pointer keeps reporting positions after it leaves the page.
        const created = tools.finishShape(drawThrough(tools, tool, [
            origin,
            {
                x: 0.5,
                y: 0.9,
            },
            {
                x: 1.2,
                y: 1.022,
            },
        ]));

        expect(created).not.toBeNull();
        expect(created!.rect.left + created!.rect.width).toBeLessThanOrEqual(1);
        expect(created!.rect.top + created!.rect.height).toBeLessThanOrEqual(1);
        expect(isNativeShapeEligible(toLegacyShapeAnnotation(created!), 1)).toBe(true);
    });

    it('splits a freehand stroke at the page edge instead of drawing along it', () => {
        const tools = useAnnotationCreationTools({surface: {settings: computed(() => null)} as IAnnotationEditorSurface});
        const created = tools.finishShape(drawThrough(tools, 'draw', [
            {
                x: 0.2,
                y: 0.7,
            },
            {
                x: 0.6,
                y: 1.2,
            },
            {
                x: 0.8,
                y: 1.2,
            },
            {
                x: 0.8,
                y: 0.7,
            },
        ]));

        expect(created?.strokes).toHaveLength(2);
        expect(created!.strokes![0]![0]).toEqual({
            x: 0.2,
            y: 0.7,
        });
        expect(created!.strokes![0]![1]!.x).toBeCloseTo(0.44);
        expect(created!.strokes![0]![1]!.y).toBe(1);
        expect(created!.strokes![1]).toEqual([
            {
                x: 0.8,
                y: 1,
            },
            {
                x: 0.8,
                y: 0.7,
            },
        ]);
        expect(created!.points).toEqual(created!.strokes![0]);
        expect(created!.rect.left).toBeCloseTo(0.2);
        expect(created!.rect.width).toBeCloseTo(0.6);
        expect(created!.rect.top).toBeCloseTo(0.7);
        expect(created!.rect.height).toBeCloseTo(0.3);
        expect(isNativeShapeEligible(toLegacyShapeAnnotation(created!), 1)).toBe(true);
    });

    it('keeps a long reentry path when the stroke left the page almost at once', () => {
        const tools = useAnnotationCreationTools({surface: {settings: computed(() => null)} as IAnnotationEditorSurface});
        const created = tools.finishShape(drawThrough(tools, 'draw', [
            {
                x: 0.9999,
                y: 0.5,
            },
            {
                x: 1.1,
                y: 0.5,
            },
            {
                x: 1.1,
                y: 0.3,
            },
            {
                x: 0.5,
                y: 0.3,
            },
        ]));

        expect(created?.strokes).toHaveLength(2);
        expect(created!.strokes![1]).toEqual([
            {
                x: 1,
                y: 0.3,
            },
            {
                x: 0.5,
                y: 0.3,
            },
        ]);
    });

    it('draws nothing for pointer travel that stays off the page', () => {
        const tools = useAnnotationCreationTools({surface: {settings: computed(() => null)} as IAnnotationEditorSurface});
        const created = tools.finishShape(drawThrough(tools, 'draw', [
            {
                x: 0.5,
                y: 0.5,
            },
            {
                x: 0.5,
                y: 1.2,
            },
            {
                x: -0.2,
                y: 0.5,
            },
            {
                x: 0.5,
                y: -0.2,
            },
        ]));

        expect(created?.strokes).toEqual([[
            {
                x: 0.5,
                y: 0.5,
            },
            {
                x: 0.5,
                y: 1,
            },
        ]]);
    });

    it('creates and selects only the text tool entity', () => {
        const createTextBoxAt = vi.fn(() => entity);
        const createNoteAt = vi.fn(() => note);
        const select = vi.fn();
        const surfaceMethods: Pick<IAnnotationEditorSurface, 'createTextBoxAt' | 'createNoteAt' | 'select'> = {
            createTextBoxAt,
            createNoteAt,
            select,
        };
        const tools = useAnnotationCreationTools({surface: {...surfaceMethods} as IAnnotationEditorSurface});

        expect(tools.create('text', 2, entity.rect)).toBe(entity);
        expect(createTextBoxAt).toHaveBeenCalledWith(2, entity.rect);
        expect(select).toHaveBeenCalledWith([entity.identity.id]);
        expect(tools.create('highlight', 2, entity.rect)).toBeNull();
        expect(createTextBoxAt).toHaveBeenCalledOnce();
    });

    it('creates and selects a canonical note for the note tool', () => {
        const createNoteAt = vi.fn(() => note);
        const select = vi.fn();
        const tools = useAnnotationCreationTools({surface: {
            createNoteAt,
            select,
        } as Pick<IAnnotationEditorSurface, 'createNoteAt' | 'select'> as IAnnotationEditorSurface});

        expect(tools.create('note', 2, note.position)).toBe(note);
        expect(createNoteAt).toHaveBeenCalledWith(2, note.position);
        expect(select).toHaveBeenCalledWith([note.identity.id]);
    });

    it('creates and selects a canonical stamp when the placement supplies its image reference', () => {
        const createStampAt = vi.fn(() => stamp);
        const select = vi.fn();
        const tools = useAnnotationCreationTools({surface: {
            createStampAt,
            select,
        } as Pick<IAnnotationEditorSurface, 'createStampAt' | 'select'> as IAnnotationEditorSurface});

        expect(tools.create('stamp', 2, stamp.rect, stamp.image)).toBe(stamp);
        expect(createStampAt).toHaveBeenCalledWith(2, stamp.rect, stamp.image);
        expect(select).toHaveBeenCalledWith([stamp.identity.id]);
        expect(tools.create('stamp', 2, stamp.rect)).toBeNull();
        expect(createStampAt).toHaveBeenCalledOnce();
    });
});
