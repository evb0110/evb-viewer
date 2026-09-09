import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    asAnnotationId,
    type ITextBoxEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {buildSerializationPlan} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import {collectNativeTextBoxMutationsForSave} from '@app/modules/pdf-viewer/runtime/save/nativeTextBoxMutations';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';

function textBox(
    id: string,
    overrides: Partial<ITextBoxEntity> = {},
): ITextBoxEntity {
    return {
        kind: 'text-box',
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(0),
        revision: 1,
        persistedRevision: 0,
        deleted: false,
        createdAt: requireEpochMs(1_781_000_000_000),
        modifiedAt: requireEpochMs(1_781_000_000_100),
        author: 'Tester',
        text: 'Canonical text box',
        rect: {
            left: 0.1,
            top: 0.2,
            width: 0.25,
            height: 0.1,
        },
        rotation: 0,
        fontSize: 16,
        color: '#112233',
        ...overrides,
    };
}

function planFor(entities: readonly ITextBoxEntity[]) {
    return buildSerializationPlan({
        documentRevisionToken: requireDocumentRevisionToken('revision-1'),
        epoch: 1,
        entityBaselineHash: 'baseline',
        revisions: new Map(entities.map(entity => [
            entity.identity.id,
            entity.revision,
        ])),
    }, entities, entities);
}

function documentWithPages(
    getPage: (pageNumber: number) => Promise<Pick<IPdfPage, 'rotate' | 'view'>>,
) {
    return {getPage};
}

describe('native canonical text-box mutations', () => {
    it.each([
        [
            0,
            [
                70,
                580,
                220,
                660,
            ],
        ],
        [
            90,
            [
                130,
                100,
                190,
                300,
            ],
        ],
        [
            180,
            [
                400,
                180,
                550,
                260,
            ],
        ],
        [
            270,
            [
                430,
                540,
                490,
                740,
            ],
        ],
    ] as const)('preserves PDF coordinates on a %s-degree page with an offset CropBox', async (rotate, expectedRect) => {
        const result = await collectNativeTextBoxMutationsForSave(
            documentWithPages(async () => ({
                rotate,
                view: [
                    10,
                    20,
                    610,
                    820,
                ],
            })),
            planFor([textBox('offset-page-box')]),
        );
        expect(result?.[0]?.rect).toEqual(expectedRect.map(value => expect.closeTo(value, 8)));
    });

    it('projects dirty canonical geometry, style, and compact object references', async () => {
        const getPage = vi.fn(async () => ({
            rotate: 0,
            view: [
                0,
                0,
                600,
                800,
            ],
        }));
        const entity = textBox('text-box-one', {
            identity: {
                id: asAnnotationId('text-box-one'),
                pdfRef: '10 0 R',
            },
            text: 'Edited text',
            fontSize: 18,
            color: '#aabbcc',
        });

        await expect(collectNativeTextBoxMutationsForSave(
            documentWithPages(getPage),
            planFor([entity]),
        )).resolves.toEqual([{
            pageIndex: requirePageIndex(0),
            stableKey: 'text-box-one',
            annotationId: '10R',
            text: 'Edited text',
            rect: [
                60,
                560,
                210,
                640,
            ],
            rotation: 0,
            fontSize: 18,
            color: [
                170,
                187,
                204,
            ],
            author: 'Tester',
            createdAt: requireEpochMs(1_781_000_000_000),
            modifiedAt: requireEpochMs(1_781_000_000_100),
        }]);
        expect(getPage).toHaveBeenCalledOnce();
        expect(getPage).toHaveBeenCalledWith(1);
    });

    it('loads a page once for multiple changed text boxes on that page', async () => {
        const getPage = vi.fn(async () => ({
            rotate: 90,
            view: [
                0,
                0,
                600,
                800,
            ],
        }));
        const first = textBox('text-box-one');
        const second = textBox('text-box-two', {
            pageIndex: requirePageIndex(0),
            text: 'Second text',
        });

        const result = await collectNativeTextBoxMutationsForSave(
            documentWithPages(getPage),
            planFor([
                first,
                second,
            ]),
        );

        expect(result).toHaveLength(2);
        expect(getPage).toHaveBeenCalledOnce();
    });

    it('returns no payload for a clean plan and fails closed for missing geometry sources', async () => {
        const getPage = vi.fn(async () => ({
            rotate: 0,
            view: [
                0,
                0,
                600,
                800,
            ],
        }));
        const clean = textBox('clean-text-box', {revision: 0});
        const invalid = textBox('invalid-text-box', {rect: {
            left: 0.1,
            top: 0.2,
            width: 0,
            height: 0.1,
        }});

        await expect(collectNativeTextBoxMutationsForSave(
            documentWithPages(getPage),
            planFor([clean]),
        )).resolves.toBeUndefined();
        await expect(collectNativeTextBoxMutationsForSave(
            documentWithPages(getPage),
            planFor([invalid]),
        )).resolves.toBeNull();
        await expect(collectNativeTextBoxMutationsForSave(
            null,
            planFor([invalid]),
        )).resolves.toBeNull();
    });
});


describe('rotated text-box native projection', () => {
    it('preserves a rotated box whose unrotated rectangle crosses the CropBox edge', async () => {
        const getPage = vi.fn(async () => ({
            rotate: 0,
            view: [
                10,
                20,
                610,
                920,
            ],
        }));
        const entity = textBox('rotated-edge', {
            rotation: 90,
            rect: {
                left: -0.05,
                top: 0.4,
                width: 0.3,
                height: 0.05,
            },
        });
        const result = await collectNativeTextBoxMutationsForSave(documentWithPages(getPage), planFor([entity]));
        expect(result?.[0]?.rect[0]).toBeCloseTo(-20);
        expect(result?.[0]?.rect[2]).toBeCloseTo(160);
        expect(result?.[0]?.rotation).toBe(90);
        // Width remains 180pt. Clamping left to zero would silently move it.
        if (!result?.[0]) throw new Error('Native text mutation missing');
        expect(result[0].rect[2] - result[0].rect[0]).toBeCloseTo(180);
    });
});
