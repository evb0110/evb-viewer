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
import type { IAnnotationEditorSurface } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import { useAnnotationCreationTools } from '@app/modules/pdf-viewer/annotations/editor/useAnnotationCreationTools';

const entity = {
    kind: 'text-box',
    identity: {id: 'text-box' as ITextBoxEntity['identity']['id']},
    pageIndex: 2,
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
    pageIndex: 2,
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
    pageIndex: 2,
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

describe('useAnnotationCreationTools', () => {
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
