import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
} from 'pdf-lib';
import type {
    PDFObject,
    PDFRef,
} from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { resolveCommentPdfRefInDocument } from '@app/modules/pdf-viewer/annotations/pdf-refs/resolveCommentPdfRefInDocument';
import {
    getPdfAnnotationIdFromStableKey,
    parsePdfAnnotationStableKey,
    parsePdfAnnotationStableKeyRef,
} from '@app/modules/pdf-viewer/annotations/pdf-refs/parsePdfAnnotationStableKey';
import { formatPdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';

interface ILiteralObject { [key: string]: PDFObject | string | number | boolean | null | undefined | ILiteralObject | TLiteralArray; }
type TLiteralArray = Array<PDFObject | string | number | boolean | null | undefined | ILiteralObject | TLiteralArray>;

describe('parsePdfAnnotationStableKey', () => {
    it('parses broad annotation stable keys without requiring PDF refs', () => {
        expect(parsePdfAnnotationStableKey(' ann:12:pdfjs_internal_editor_0 ')).toEqual({
            stableKey: 'ann:12:pdfjs_internal_editor_0',
            pageIndex: 12,
            annotationId: 'pdfjs_internal_editor_0',
        });
        expect(getPdfAnnotationIdFromStableKey('ann:0:12R0')).toBe('12R0');
    });

    it('parses and normalizes PDF ref annotation stable keys', () => {
        expect(parsePdfAnnotationStableKeyRef('ann:3:12R')).toEqual({
            stableKey: 'ann:3:12R',
            pageIndex: 3,
            annotationId: '12R',
            ref: {
                objectNumber: 12,
                generationNumber: 0,
            },
            normalizedAnnotationId: '12R',
        });
        expect(parsePdfAnnotationStableKeyRef('ann:3:12R4')?.normalizedAnnotationId).toBe('12R4');
        expect(parsePdfAnnotationStableKeyRef('ann:3:12 4 R')).toEqual({
            stableKey: 'ann:3:12 4 R',
            pageIndex: 3,
            annotationId: '12 4 R',
            ref: {
                objectNumber: 12,
                generationNumber: 4,
            },
            normalizedAnnotationId: '12R4',
        });
    });

    it('rejects invalid page indexes and non-ref strict stable keys', () => {
        expect(parsePdfAnnotationStableKey('ann:-1:12R0')).toBeNull();
        expect(parsePdfAnnotationStableKey('ann:1:')).toBeNull();
        expect(parsePdfAnnotationStableKeyRef('ann:1:pdfjs_internal_editor_0')).toBeNull();
        expect(parsePdfAnnotationStableKeyRef('uid:1:12R0')).toBeNull();
    });
});

function createEditorComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'editor:0:pdfjs_internal_editor_0',
        stableKey: 'ann:0:pdfjs_internal_editor_0',
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        author: null,
        modifiedAt: null,
        color: null,
        uid: 'pdfjs_internal_editor_0',
        annotationId: null,
        source: 'editor',
        hasNote: true,
        markerRect: null,
        kindLabel: null,
        subtype: null,
        ...overrides,
    };
}

function createPdfComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'pdf:0:1',
        stableKey: 'ann:0:1',
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        author: null,
        modifiedAt: null,
        color: null,
        uid: '1',
        annotationId: null,
        source: 'pdf',
        hasNote: false,
        markerRect: null,
        kindLabel: null,
        subtype: null,
        ...overrides,
    };
}

interface IAnnotationFixture {
    subtype?: string;
    contents?: string;
    author?: string;
}

async function createPdfWithTextAnnotations(count: number) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);
    const annots = doc.context.obj([]);
    const refs: PDFRef[] = [];

    for (let index = 0; index < count; index += 1) {
        const left = 60 + (index * 18);
        const top = 700 - (index * 18);
        const annotDict = doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Text'),
            Rect: [
                PDFNumber.of(left),
                PDFNumber.of(top),
                PDFNumber.of(left + 12),
                PDFNumber.of(top + 12),
            ],
        });
        const ref = doc.context.register(annotDict);
        refs.push(ref);
        annots.push(ref);
    }

    page.node.set(PDFName.of('Annots'), annots);
    return {
        doc,
        refs,
    };
}

async function createPdfWithFixtures(fixtures: IAnnotationFixture[]) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);
    const annots = doc.context.obj([]);
    const refs: PDFRef[] = [];

    fixtures.forEach((fixture, index) => {
        const left = 60 + (index * 18);
        const top = 700 - (index * 18);
        const annotShape: ILiteralObject = {
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of(fixture.subtype ?? 'Text'),
            Rect: [
                PDFNumber.of(left),
                PDFNumber.of(top),
                PDFNumber.of(left + 12),
                PDFNumber.of(top + 12),
            ],
        };
        if (fixture.contents !== undefined) {
            annotShape.Contents = PDFHexString.fromText(fixture.contents);
        }
        if (fixture.author !== undefined) {
            annotShape.T = PDFHexString.fromText(fixture.author);
        }
        const annotDict = doc.context.obj(annotShape);
        const ref = doc.context.register(annotDict);
        refs.push(ref);
        annots.push(ref);
    });

    page.node.set(PDFName.of('Annots'), annots);
    return {
        doc,
        refs,
    };
}

describe('resolveCommentPdfRefInDocument', () => {
    it('falls back to the sole note-like annotation for editor comment without explicit ref', async () => {
        const {
            doc,
            refs,
        } = await createPdfWithTextAnnotations(1);
        const resolved = resolveCommentPdfRefInDocument(doc, createEditorComment());

        expect(resolved?.toString()).toBe(refs[0]?.toString());
    });

    it('keeps editor fallback conservative when multiple note-like refs are ambiguous', async () => {
        const { doc } = await createPdfWithTextAnnotations(2);
        const resolved = resolveCommentPdfRefInDocument(doc, createEditorComment());

        expect(resolved).toBeNull();
    });

    it('returns the explicit ref when annotationId resolves on the page (priority over scoring)', async () => {
        const {
            doc,
            refs,
        } = await createPdfWithFixtures([
            { contents: 'alpha' },
            { contents: 'beta' },
        ]);
        const targetRef = refs[1];
        if (!targetRef) {
            throw new Error('expected ref');
        }

        const resolved = resolveCommentPdfRefInDocument(
            doc,
            createPdfComment({
                annotationId: formatPdfJsAnnotationRef(targetRef),
                text: 'alpha',
            }),
        );

        expect(resolved?.toString()).toBe(targetRef.toString());
    });

    it('uses generated pdf-page-index id when explicit ref is unavailable', async () => {
        const {
            doc,
            refs,
        } = await createPdfWithFixtures([
            { contents: 'alpha' },
            { contents: 'beta' },
        ]);
        const targetRef = refs[1];
        if (!targetRef) {
            throw new Error('expected ref');
        }

        const resolved = resolveCommentPdfRefInDocument(
            doc,
            createPdfComment({
                id: 'pdf-1-1',
                text: 'alpha',
            }),
        );

        expect(resolved?.toString()).toBe(targetRef.toString());
    });

    it('does not clamp generated pdf-page-index ids to an unrelated page', async () => {
        const { doc } = await createPdfWithFixtures([{ contents: '' }]);

        const resolved = resolveCommentPdfRefInDocument(
            doc,
            createPdfComment({
                id: 'pdf-99-0',
                pageIndex: 98,
                pageNumber: 99,
                text: '',
            }),
        );

        expect(resolved).toBeNull();
    });

    it('chooses by exact text match when explicit and generated lookups fail', async () => {
        const {
            doc,
            refs,
        } = await createPdfWithFixtures([
            { contents: 'alpha' },
            { contents: 'beta' },
            { contents: 'gamma' },
        ]);
        const targetRef = refs[1];
        if (!targetRef) {
            throw new Error('expected ref');
        }

        const resolved = resolveCommentPdfRefInDocument(
            doc,
            createPdfComment({
                id: 'pdf:0:beta',
                text: 'beta',
            }),
        );

        expect(resolved?.toString()).toBe(targetRef.toString());
    });

    it('returns null for non-editor comments when no candidate clears the score threshold', async () => {
        const { doc } = await createPdfWithFixtures([
            { contents: 'alpha' },
            { contents: 'beta' },
        ]);

        const resolved = resolveCommentPdfRefInDocument(
            doc,
            createPdfComment({
                id: 'pdf:0:zeta',
                text: '',
            }),
        );

        expect(resolved).toBeNull();
    });

    it('prefers a unique editor candidate by author tie-break when text is empty', async () => {
        const {
            doc,
            refs,
        } = await createPdfWithFixtures([
            {
                contents: '',
                author: 'alice',
            },
            {
                contents: 'noise',
                author: 'bob',
            },
        ]);
        const targetRef = refs[0];
        if (!targetRef) {
            throw new Error('expected ref');
        }

        const resolved = resolveCommentPdfRefInDocument(
            doc,
            createEditorComment({
                author: 'alice',
                text: '',
            }),
        );

        expect(resolved?.toString()).toBe(targetRef.toString());
    });

    it('returns null for editor fallback when best margin over second-best is too small', async () => {
        const { doc } = await createPdfWithFixtures([
            {
                subtype: 'FreeText',
                contents: '',
            },
            {
                subtype: 'FreeText',
                contents: '',
            },
        ]);

        const resolved = resolveCommentPdfRefInDocument(
            doc,
            createEditorComment({
                text: '',
                subtype: null,
            }),
        );

        expect(resolved).toBeNull();
    });
});
