import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    AnnotationEntity,
    IAnnotationReply,
    IPlacedImageEntity,
    INoteEntity,
    IShapeEntity,
    ITextBoxEntity,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    asAnnotationId,
    semanticEntityFingerprint,
    semanticSnapshot,
    semanticSnapshotsEqual,
    toLegacyShapeAnnotation,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

const identity = (id: string, pdfRef?: string) => ({
    id: asAnnotationId(id),
    ...(pdfRef === undefined ? {} : {pdfRef}),
});

const rect = {
    left: 0.125,
    top: 0.25,
    width: 0.5,
    height: 0.125,
} as const;

function textBox(overrides: Partial<ITextBoxEntity> = {}): ITextBoxEntity {
    return {
        kind: 'text-box',
        identity: identity('text-box'),
        pageIndex: 2,
        revision: 3,
        persistedRevision: 2,
        deleted: false,
        createdAt: 1,
        modifiedAt: 2,
        author: 'Author',
        text: 'Text',
        rect,
        rotation: 0,
        fontSize: 12,
        color: '#ff0000',
        ...overrides,
    };
}

function note(overrides: Partial<INoteEntity> = {}): INoteEntity {
    return {
        kind: 'note',
        identity: identity('note'),
        pageIndex: 2,
        revision: 3,
        persistedRevision: 2,
        deleted: false,
        createdAt: 1,
        modifiedAt: 2,
        author: 'Author',
        contents: 'Contents',
        position: rect,
        color: '#00ff00',
        open: false,
        ...overrides,
    };
}

function textMarkup(overrides: Partial<ITextMarkupEntity> = {}): ITextMarkupEntity {
    return {
        kind: 'text-markup',
        identity: identity('text-markup'),
        pageIndex: 2,
        revision: 3,
        persistedRevision: 2,
        deleted: false,
        createdAt: 1,
        modifiedAt: 2,
        author: 'Author',
        subtype: 'Highlight',
        contents: 'Contents',
        quadPoints: [rect],
        color: '#0000ff',
        opacity: 1,
        ...overrides,
    };
}

function placedImage(overrides: Partial<IPlacedImageEntity> = {}): IPlacedImageEntity {
    return {
        kind: 'placed-image',
        identity: identity('placed-image'),
        pageIndex: 2,
        revision: 3,
        persistedRevision: 2,
        deleted: false,
        createdAt: 1,
        modifiedAt: 2,
        author: 'Author',
        rect,
        rotation: 90,
        image: {
            objectNumber: 7,
            generationNumber: 0,
            byteLength: 128,
            sha256: 'A'.repeat(64),
        },
        ...overrides,
    };
}

function shape(overrides: Partial<IShapeEntity> = {}): IShapeEntity {
    return {
        kind: 'shape',
        identity: identity('shape'),
        pageIndex: 2,
        revision: 3,
        persistedRevision: 2,
        deleted: false,
        createdAt: 1,
        modifiedAt: 2,
        author: 'Author',
        tool: 'rectangle',
        rect,
        points: [{
            x: 0.125,
            y: 0.25,
        }],
        strokes: [[{
            x: 0.25,
            y: 0.5,
        }]],
        strokeColor: '#ABCDEF',
        strokeWidth: 2,
        fill: '#fff',
        opacity: 1,
        ...overrides,
    };
}

function entities(): AnnotationEntity[] {
    return [
        textBox(),
        note(),
        textMarkup(),
        placedImage(),
        shape(),
    ];
}

describe('annotation entity semantic equality', () => {
    it('round-trips every canonical kind through its fingerprint', () => {
        entities().forEach((entity) => {
            const roundTripped = structuredClone(entity);
            expect(semanticEntityFingerprint(roundTripped)).toBe(semanticEntityFingerprint(entity));
        });
    });

    it('keeps geometry within one quantization step equal and separates two steps', () => {
        const baselineLeft = 0.249951;
        const baseline = textBox({rect: {
            ...rect,
            left: baselineLeft,
        }});
        const withinStep = textBox({rect: {
            ...rect,
            // 0.000098 apart, just inside the 1e-4 equality tolerance.
            left: baselineLeft + 0.000098,
        }});
        const outsideStep = textBox({rect: {
            ...rect,
            // 0.0002 apart, which must occupy a different quantization bucket.
            left: baselineLeft + 0.0002,
        }});

        expect(semanticEntityFingerprint(withinStep)).toBe(semanticEntityFingerprint(baseline));
        expect(semanticEntityFingerprint(outsideStep)).not.toBe(semanticEntityFingerprint(baseline));
    });

    it('normalizes colors to the same lowercase 8-bit RGB spelling', () => {
        const baseline = textBox({color: '#ff0000'});
        expect(semanticEntityFingerprint(textBox({color: '#F00'})))
            .toBe(semanticEntityFingerprint(baseline));
        expect(semanticEntityFingerprint(textBox({color: 'rgb(255, 0, 0)'})))
            .toBe(semanticEntityFingerprint(baseline));
        expect(semanticEntityFingerprint(textBox({color: 'rgb(254.6, 0.4, 0.4)'})))
            .toBe(semanticEntityFingerprint(baseline));
        expect(semanticEntityFingerprint(textBox({color: 'rgba(50% , 25% , 75% , 0.5)'})))
            .toBe(semanticEntityFingerprint(textBox({color: '#8040bf'})));
        expect(semanticEntityFingerprint(textBox({color: 'transparent'})))
            .not.toBe(semanticEntityFingerprint(textBox({color: '#000000'})));
        expect(semanticEntityFingerprint(textBox({color: 'constructor'})))
            .toContain('"color":"constructor"');
        expect(semanticEntityFingerprint(shape({strokeColor: '#ABCDEF'})))
            .toContain('"strokeColor":"#abcdef"');
        expect(semanticEntityFingerprint(shape()))
            .toContain('"fill":"#ffffff"');
    });

    it('projects a flat shape to the temporary legacy serializer record', () => {
        const entity = shape({
            identity: identity('shape', '9R'),
            tool: 'arrow',
            rect: {
                left: 0.2,
                top: 0.3,
                width: 0.4,
                height: 0.1,
            },
            points: [
                {
                    x: 0.2,
                    y: 0.3,
                },
                {
                    x: 0.6,
                    y: 0.4,
                },
            ],
        });
        const legacy = toLegacyShapeAnnotation(entity);

        expect(legacy).toMatchObject({
            id: 'shape',
            type: 'arrow',
            pageIndex: 2,
            x: 0.2,
            y: 0.3,
            width: 0.4,
            height: 0.1,
            x2: 0.6,
            y2: 0.4,
            annotationId: '9R',
            pdfSubtype: 'Line',
            lineEndStyle: 'closedArrow',
        });
        expect(legacy.points).toEqual(entity.points);
        expect(legacy.points).not.toBe(entity.points);
    });

    it('rounds opacity to two decimal places at the stated boundaries', () => {
        const baseline = textMarkup({opacity: 1});
        expect(semanticEntityFingerprint(textMarkup({opacity: 0.996})))
            .toBe(semanticEntityFingerprint(baseline));
        expect(semanticEntityFingerprint(textMarkup({opacity: 0.994})))
            .not.toBe(semanticEntityFingerprint(baseline));
    });

    it('compares text after Unicode NFC normalization', () => {
        expect(semanticEntityFingerprint(textBox({text: 'café'})))
            .toBe(semanticEntityFingerprint(textBox({text: 'cafe\u0301'})));
    });

    it('excludes identity, revisions, dates and derived fields', () => {
        const replies: IAnnotationReply[] = [{
            objectNumber: 9,
            generationNumber: 0,
            contents: 'Reply',
            author: 'Other author',
            createdAt: 10,
            modifiedAt: 11,
        }];
        const baseline = note({replies});
        const reopened = note({
            identity: identity('reopened-note', '18R'),
            revision: 19,
            persistedRevision: 18,
            createdAt: 100,
            modifiedAt: 200,
            replies: [{
                ...replies[0]!,
                contents: 'A changed derived reply',
            }],
        });
        expect(semanticEntityFingerprint(reopened)).toBe(semanticEntityFingerprint(baseline));

        const markup = textMarkup({selectedText: 'selected document text'});
        expect(semanticEntityFingerprint(textMarkup({selectedText: null})))
            .toBe(semanticEntityFingerprint(markup));
    });

    it('keeps author in the round-trip oracle while excluding only its timestamps', () => {
        expect(semanticEntityFingerprint(note({author: 'A'})))
            .not.toBe(semanticEntityFingerprint(note({author: 'B'})));
        expect(semanticEntityFingerprint(note({
            createdAt: 1,
            modifiedAt: 2,
        })))
            .toBe(semanticEntityFingerprint(note({
                createdAt: 3,
                modifiedAt: 4,
            })));
    });

    it('keeps page and deletion state in the in-app snapshot oracle', () => {
        const baseline = semanticSnapshot([note()]);
        expect(semanticSnapshotsEqual(baseline, semanticSnapshot([note({pageIndex: 3})]))).toBe(false);
        expect(semanticSnapshotsEqual(baseline, semanticSnapshot([note({deleted: true})]))).toBe(false);
        expect(semanticSnapshotsEqual(baseline, semanticSnapshot([note({
            identity: identity('note', '44R'),
            revision: 99,
            persistedRevision: 99,
            createdAt: 99,
            modifiedAt: 100,
            replies: [],
        })]))).toBe(true);
    });
});
