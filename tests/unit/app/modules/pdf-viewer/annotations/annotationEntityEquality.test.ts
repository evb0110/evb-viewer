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
    buildTextMarkupSelectionPlan,
    semanticEntityFingerprint,
    semanticSnapshot,
    semanticSnapshotsEqual,
    toLegacyShapeAnnotation,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';

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
        pageIndex: requirePageIndex(2),
        revision: 3,
        persistedRevision: 2,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(2),
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
        pageIndex: requirePageIndex(2),
        revision: 3,
        persistedRevision: 2,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(2),
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
        pageIndex: requirePageIndex(2),
        revision: 3,
        persistedRevision: 2,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(2),
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
        pageIndex: requirePageIndex(2),
        revision: 3,
        persistedRevision: 2,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(2),
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
        pageIndex: requirePageIndex(2),
        revision: 3,
        persistedRevision: 2,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(2),
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
            pageIndex: requirePageIndex(2),
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
            createdAt: requireEpochMs(10),
            modifiedAt: requireEpochMs(11),
        }];
        const baseline = note({replies});
        const reopened = note({
            identity: identity('reopened-note', '18R'),
            revision: 19,
            persistedRevision: 18,
            createdAt: requireEpochMs(100),
            modifiedAt: requireEpochMs(200),
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
            createdAt: requireEpochMs(1),
            modifiedAt: requireEpochMs(2),
        })))
            .toBe(semanticEntityFingerprint(note({
                createdAt: requireEpochMs(3),
                modifiedAt: requireEpochMs(4),
            })));
    });

    it('keeps page and deletion state in the in-app snapshot oracle', () => {
        const baseline = semanticSnapshot([note()]);
        expect(semanticSnapshotsEqual(baseline, semanticSnapshot([note({pageIndex: requirePageIndex(3)})]))).toBe(false);
        expect(semanticSnapshotsEqual(baseline, semanticSnapshot([note({deleted: true})]))).toBe(false);
        expect(semanticSnapshotsEqual(baseline, semanticSnapshot([note({
            identity: identity('note', '44R'),
            revision: 99,
            persistedRevision: 99,
            createdAt: requireEpochMs(99),
            modifiedAt: requireEpochMs(100),
            replies: [],
        })]))).toBe(true);
    });
});

describe('highlight merging and geometry union', () => {
    it('preserves exact fixed-point discovery order for merged notes, canonical identity, and touching-edge separation', () => {
        // C2 overlaps created; C2 overlaps C3 (forward in pass 0) and C1 (backward -> pass 1);
        // C1 overlaps C0 (backward -> pass 2); C4 only touches C3 at x=0.50 so must stay separate.
        const c0 = textMarkup({
            identity: identity('hl-c0'),
            createdAt: requireEpochMs(50),
            contents: 'note-c0',
            quadPoints: [{
                left: 0.0,
                top: 0.1,
                width: 0.12,
                height: 0.02,
            }],
        });
        const c1 = textMarkup({
            identity: identity('hl-c1'),
            createdAt: requireEpochMs(40),
            contents: 'note-c1',
            quadPoints: [{
                left: 0.1,
                top: 0.1,
                width: 0.12,
                height: 0.02,
            }],
        });
        const c2 = textMarkup({
            identity: identity('hl-c2', '12R'),
            createdAt: requireEpochMs(10),
            contents: 'note-c2',
            quadPoints: [{
                left: 0.2,
                top: 0.1,
                width: 0.15,
                height: 0.02,
            }],
        });
        const c3 = textMarkup({
            identity: identity('hl-c3'),
            createdAt: requireEpochMs(20),
            contents: 'note-c3',
            quadPoints: [{
                left: 0.34,
                top: 0.1,
                width: 0.16,
                height: 0.02,
            }],
        });
        const c4Touching = textMarkup({
            identity: identity('hl-c4-touching'),
            createdAt: requireEpochMs(5),
            contents: 'note-touching',
            quadPoints: [{
                left: 0.5,
                top: 0.1,
                width: 0.1,
                height: 0.02,
            }],
        });
        const created = textMarkup({
            identity: identity('hl-created'),
            createdAt: requireEpochMs(100),
            persistedRevision: -1,
            contents: 'note-created',
            quadPoints: [{
                left: 0.25,
                top: 0.1,
                width: 0.05,
                height: 0.02,
            }],
        });

        const plan = buildTextMarkupSelectionPlan({
            created,
            overlapCandidates: [],
            entities: [
                c0,
                c1,
                c2,
                c3,
                c4Touching,
            ],
        });

        // Canonical identity is c2 (persisted via pdfRef + earliest createdAt).
        expect(plan.projection.created.identity).toEqual(c2.identity);
        // Exact pass-by-pass discovery order: c2 (pass 0) -> c3 (pass 0) -> c1 (pass 1) -> c0 (pass 2), then created.
        expect(plan.projection.created.contents).toBe('note-c2\n\nnote-c3\n\nnote-c1\n\nnote-c0\n\nnote-created');
        expect(plan.replacements.map(replacement => replacement.after.identity.id)).toEqual([
            c2.identity.id,
            c3.identity.id,
            c1.identity.id,
            c0.identity.id,
        ]);
        // Merged geometry covers [0.0, 0.5] x [0.1, 0.12] as one clean non-overlapping quad.
        expect(plan.projection.created.quadPoints).toEqual([{
            left: 0,
            top: 0.1,
            width: 0.5,
            height: 0.02,
        }]);
    });

    it('produces exact non-overlapping axis-aligned union quads for staggered multi-row overlaps', () => {
        const first = textMarkup({
            identity: identity('hl-a'),
            createdAt: requireEpochMs(1),
            quadPoints: [{
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.1,
            }],
        });
        const second = textMarkup({
            identity: identity('hl-b'),
            createdAt: requireEpochMs(2),
            quadPoints: [{
                left: 0.2,
                top: 0.25,
                width: 0.3,
                height: 0.1,
            }],
        });
        const plan = buildTextMarkupSelectionPlan({
            created: second,
            overlapCandidates: [],
            entities: [first],
        });

        // X partitions: [0.1, 0.2] -> [0.2, 0.3], [0.2, 0.4] -> [0.2, 0.35], [0.4, 0.5] -> [0.25, 0.35].
        expect(plan.projection.created.quadPoints).toEqual([
            {
                left: 0.1,
                top: 0.2,
                width: 0.1,
                height: 0.1,
            },
            {
                left: 0.2,
                top: 0.2,
                width: 0.2,
                height: 0.15,
            },
            {
                left: 0.4,
                top: 0.25,
                width: 0.1,
                height: 0.1,
            },
        ]);
    });

    it('merges a reverse-ordered 800-highlight chain without cubic blowup', () => {
        const count = 800;
        const chain = Array.from({length: count}, (_, index) => textMarkup({
            identity: identity(`chain-${index}`),
            createdAt: requireEpochMs(1000 + index),
            contents: index === 0 || index === count - 1 ? `note-${index}` : '',
            quadPoints: [{
                left: (count - 1 - index) * 0.001,
                top: 0.1,
                width: 0.0015,
                height: 0.02,
            }],
        }));
        const created = textMarkup({
            identity: identity('chain-created'),
            createdAt: requireEpochMs(9999),
            persistedRevision: -1,
            contents: 'note-created',
            quadPoints: [{
                left: -0.0005,
                top: 0.1,
                width: 0.0015,
                height: 0.02,
            }],
        });

        const startedAt = performance.now();
        const plan = buildTextMarkupSelectionPlan({
            created,
            overlapCandidates: [],
            entities: chain,
        });
        const elapsedMs = performance.now() - startedAt;

        expect(plan.replacements).toHaveLength(count);
        expect(plan.projection.created.identity.id).toBe(asAnnotationId('chain-0'));
        expect(plan.projection.created.contents).toBe(`note-0\n\nnote-${count - 1}\n\nnote-created`);
        expect(plan.projection.created.quadPoints).toEqual([{
            left: -0.0005,
            top: 0.1,
            width: 0.801,
            height: 0.02,
        }]);
        expect(elapsedMs).toBeLessThan(400);
    });
});
