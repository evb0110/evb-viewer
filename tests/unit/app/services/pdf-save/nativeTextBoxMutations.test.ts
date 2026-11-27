import type {IPdfDocument, IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {describe, expect, it, vi} from 'vitest';
import {asAnnotationId, type ITextBoxEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {buildSerializationPlan} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import {
    collectNativeTextBoxMutationsForSave,
    fitNativeTextBox,
    prepareNativeTextBoxPagePaint,
    type INativeTextBoxAppearance,
} from '@app/modules/pdf-viewer/runtime/save/nativeTextBoxMutations';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';
import {
    recordPdfDocumentLoadedRevision,
    recordPdfDocumentOriginalAnnotations,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentLoadedRevision';
import {cast} from '@tests/helpers/cast';

const {renderTextBoxAppearance} = vi.hoisted(() => ({renderTextBoxAppearance: vi.fn()}));
vi.mock('@app/utils/platformDocuments', () => ({getPageOpsCapability: () => ({renderTextBoxAppearance})}));

function textBox(id: string, overrides: Partial<ITextBoxEntity> = {}): ITextBoxEntity {
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
    return buildSerializationPlan(
        {
            documentRevisionToken: requireDocumentRevisionToken('revision-1'),
            epoch: 1,
            entityBaselineHash: 'baseline',
            revisions: new Map(entities.map((entity) => [entity.identity.id, entity.revision])),
        },
        entities,
        entities,
    );
}

function documentWithPages(getPage: (pageNumber: number) => Promise<Pick<IPdfPage, 'rotate' | 'view'>>) {
    return {getPage};
}

describe('native canonical text-box mutations', () => {
    it.each([
        [0, [70, 580, 220, 660]],
        [90, [130, 100, 190, 300]],
        [180, [400, 180, 550, 260]],
        [270, [430, 540, 490, 740]],
    ] as const)('preserves PDF coordinates on a %s-degree page with an offset CropBox', async (rotate, expectedRect) => {
        const result = await collectNativeTextBoxMutationsForSave(
            documentWithPages(async () => ({
                rotate,
                view: [10, 20, 610, 820],
            })),
            planFor([textBox('offset-page-box')]),
        );
        expect(result?.[0]?.rect).toEqual(expectedRect.map((value) => expect.closeTo(value, 8)));
    });

    it('projects dirty canonical geometry, style, and compact object references', async () => {
        const getPage = vi.fn(async () => ({
            rotate: 0,
            view: [0, 0, 600, 800],
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

        await expect(collectNativeTextBoxMutationsForSave(documentWithPages(getPage), planFor([entity]))).resolves.toEqual([
            {
                pageIndex: requirePageIndex(0),
                stableKey: 'text-box-one',
                annotationId: '10R',
                text: 'Edited text',
                rect: [60, 560, 210, 640],
                rotation: 0,
                fontSize: 18,
                color: [170, 187, 204],
                author: 'Tester',
                createdAt: requireEpochMs(1_781_000_000_000),
                modifiedAt: requireEpochMs(1_781_000_000_100),
            },
        ]);
        expect(getPage).toHaveBeenCalledOnce();
        expect(getPage).toHaveBeenCalledWith(1);
    });

    it('retains the imported frame when recreating an edited deleted box', async () => {
        const source = {
            version: 1,
            borderWidth: 2,
            borderColor: [1, 0, 0],
            background: [1, 1, 0],
            rawRD: [3, 4, 5, 6],
            staleFill: false,
        };
        const original = cast<IPdfAnnotationParseResult>({
            entities: [
                {
                    kind: 'text-box',
                    name: 'history-box',
                    objectNumber: 10,
                    generationNumber: 0,
                    pageIndex: 0,
                    text: 'Original',
                    rect: {
                        left: 0.1,
                        top: 0.2,
                        width: 0.25,
                        height: 0.1,
                    },
                    rotation: 0,
                    fontSize: 16,
                    color: '#112233',
                    author: null,
                    createdAt: null,
                    modifiedAt: null,
                    source,
                },
            ],
        });
        const entity = textBox('history-box', {
            text: 'Edited',
            persistedRevision: -1,
        });
        const result = await collectNativeTextBoxMutationsForSave(
            documentWithPages(async () => ({
                rotate: 0,
                view: [0, 0, 600, 800],
            })),
            planFor([entity]),
            original,
        );
        expect(result?.[0]).toMatchObject({
            text: 'Edited',
            source,
        });
        expect(result?.[0]?.originalAppearance).toBeUndefined();
    });

    it('loads a page once for multiple changed text boxes on that page', async () => {
        const getPage = vi.fn(async () => ({
            rotate: 90,
            view: [0, 0, 600, 800],
        }));
        const first = textBox('text-box-one');
        const second = textBox('text-box-two', {
            pageIndex: requirePageIndex(0),
            text: 'Second text',
        });

        const result = await collectNativeTextBoxMutationsForSave(documentWithPages(getPage), planFor([first, second]));

        expect(result).toHaveLength(2);
        expect(getPage).toHaveBeenCalledOnce();
    });

    it('returns no payload for a clean plan and fails closed for missing geometry sources', async () => {
        const getPage = vi.fn(async () => ({
            rotate: 0,
            view: [0, 0, 600, 800],
        }));
        const clean = textBox('clean-text-box', {revision: 0});
        const invalid = textBox('invalid-text-box', {
            rect: {
                left: 0.1,
                top: 0.2,
                width: 0,
                height: 0.1,
            },
        });

        await expect(collectNativeTextBoxMutationsForSave(documentWithPages(getPage), planFor([clean]))).resolves.toBeUndefined();
        await expect(collectNativeTextBoxMutationsForSave(documentWithPages(getPage), planFor([invalid]))).resolves.toBeNull();
        await expect(collectNativeTextBoxMutationsForSave(null, planFor([invalid]))).resolves.toBeNull();
    });
});

describe('rotated text-box native projection', () => {
    it('preserves a rotated box whose unrotated rectangle crosses the CropBox edge', async () => {
        const getPage = vi.fn(async () => ({
            rotate: 0,
            view: [10, 20, 610, 920],
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
        if (!result?.[0]) {
            throw new Error('Native text mutation missing');
        }
        expect(result[0].rect[2] - result[0].rect[0]).toBeCloseTo(180);
    });
});

describe('accepted text-box appearance', () => {
    const page = cast<IPdfPage>({
        pageNumber: 1,
        rotate: 0,
        view: [0, 0, 600, 800],
        getViewport: () => ({userUnit: 1}),
    });

    function writerAppearance(fittedFontSize: number, byte: number) {
        return {
            data: new Uint8Array([byte]),
            textBoxes: [
                {
                    stableKey: 'accepted-box',
                    fittedFontSize,
                },
            ],
        };
    }

    function paintAccepted(entity: ITextBoxEntity, appearance: INativeTextBoxAppearance | undefined) {
        return prepareNativeTextBoxPagePaint({
            document: cast<IPdfDocument>({}),
            page,
            annotations: [],
            entities: [entity],
            excludedIds: new Set(),
            editingId: null,
            editingDraft: false,
            writerParse: null,
            workingCopyPath: null,
            acceptedAppearance: appearance,
            signature: '',
        });
    }

    it('paints an accepted text box with the appearance its fit produced', async () => {
        renderTextBoxAppearance.mockReset().mockResolvedValueOnce(writerAppearance(16, 7));
        const accepted = textBox('accepted-box', {text: 'Accepted text'});
        const {appearance, ...fitted} = await fitNativeTextBox(accepted, page, null, null, null);

        const input = await paintAccepted(
            {
                ...accepted,
                ...fitted,
            },
            appearance,
        );

        expect(renderTextBoxAppearance).toHaveBeenCalledOnce();
        expect(input.nativeAnnotationAppearance?.pdf).toEqual([new Uint8Array([7])]);
        expect(input.nativeAnnotationAppearance?.annotations).toEqual([
            {
                action: 'append',
                id: 'accepted-box',
                appearanceDocument: 0,
                appearanceIndex: 0,
            },
        ]);
    });

    it('asks the writer again when fitting changed the font size', async () => {
        renderTextBoxAppearance.mockReset().mockResolvedValueOnce(writerAppearance(12, 7)).mockResolvedValueOnce(writerAppearance(12, 9));
        const accepted = textBox('accepted-box', {text: 'Accepted text that overflows its box'});
        const {appearance, ...fitted} = await fitNativeTextBox(accepted, page, null, null, null);

        const input = await paintAccepted(
            {
                ...accepted,
                ...fitted,
            },
            appearance,
        );

        expect(renderTextBoxAppearance).toHaveBeenCalledTimes(2);
        expect(input.nativeAnnotationAppearance?.pdf).toEqual([new Uint8Array([9])]);
    });

    it('maps multi-batch text-box appearance documents accurately and scales across 500 pages x 2,000 parsed annotations', async () => {
        // Multi-batch test: >256 text boxes forces multiple native appearance batches plus committed reuse.
        const boxCount = 260;
        const entities = Array.from({length: boxCount}, (_, index) =>
            textBox(`batch-box-${index}`, {
                text: `Box ${index}`,
            }),
        );
        let batchSeq = 0;
        renderTextBoxAppearance.mockReset().mockImplementation(
            async (
                _path: string | null,
                request: {
                    textBoxes: Array<{textBox: {stableKey: string}}>;
                },
            ) => {
                batchSeq += 1;
                return {
                    data: new Uint8Array([batchSeq]),
                    textBoxes: request.textBoxes.map((entry) => ({
                        stableKey: entry.textBox.stableKey,
                        fittedFontSize: 16,
                    })),
                };
            },
        );

        const firstPaint = await prepareNativeTextBoxPagePaint({
            document: cast<IPdfDocument>({}),
            page,
            annotations: [],
            entities,
            excludedIds: new Set(),
            editingId: null,
            editingDraft: false,
            writerParse: null,
            workingCopyPath: null,
            signature: 'batch-1',
        });

        expect(renderTextBoxAppearance).toHaveBeenCalledTimes(2);
        expect(firstPaint.nativeTextBoxInputs).toHaveLength(boxCount);
        expect(firstPaint.nativeTextBoxInputs?.[0]).toMatchObject({
            id: 'batch-box-0',
            appearanceDocument: 0,
            appearanceIndex: 0,
        });
        expect(firstPaint.nativeTextBoxInputs?.[256]).toMatchObject({
            id: 'batch-box-256',
            appearanceDocument: 1,
            appearanceIndex: 0,
        });

        // Second paint reuses committed appearances for all unchanged boxes and only renders the 1 edited box.
        const editedEntities = [...entities.slice(0, 10), textBox('batch-box-10', {text: 'Edited box 10'}), ...entities.slice(11)];
        const secondPaint = await prepareNativeTextBoxPagePaint({
            document: cast<IPdfDocument>({}),
            page,
            annotations: [],
            entities: editedEntities,
            excludedIds: new Set(),
            editingId: null,
            editingDraft: false,
            writerParse: null,
            workingCopyPath: null,
            currentInput: firstPaint,
            signature: 'batch-2',
        });

        expect(renderTextBoxAppearance).toHaveBeenCalledTimes(3);
        expect(secondPaint.nativeTextBoxInputs?.[0]).toMatchObject({
            id: 'batch-box-0',
            appearanceDocument: 0,
            appearanceIndex: 0,
        });
        expect(secondPaint.nativeTextBoxInputs?.[10]).toMatchObject({
            id: 'batch-box-10',
            appearanceDocument: 2,
            appearanceIndex: 0,
        });

        // 500 pages x 2,000 parsed annotations indexed once by page.
        const parsedEntities = Array.from({length: 2_000}, (_, index) => ({
            kind: 'note' as const,
            name: `note-${index}`,
            objectNumber: index + 10,
            generationNumber: 0,
            pageIndex: index % 500,
            contents: `c-${index}`,
            position: {
                left: 0.1,
                top: 0.1,
                width: 0.05,
                height: 0.05,
            },
            color: '#ffcc00',
            open: false,
            author: null,
            createdAt: null,
            modifiedAt: null,
        }));
        const doc = cast<IPdfDocument>({});
        const rev = requireDocumentRevisionToken('rev-paint-scale');
        recordPdfDocumentLoadedRevision(doc, rev);
        await recordPdfDocumentOriginalAnnotations(
            doc,
            cast<IPdfAnnotationParseResult>({
                documentRevisionToken: rev,
                entities: parsedEntities,
            }),
        );

        const startedAt = performance.now();
        for (let pageNumber = 1; pageNumber <= 500; pageNumber += 1) {
            const paintInput = await prepareNativeTextBoxPagePaint({
                document: doc,
                page: cast<IPdfPage>({
                    pageNumber,
                    rotate: 0,
                    view: [0, 0, 600, 800],
                    getViewport: () => ({userUnit: 1}),
                }),
                annotations: [],
                entities: [],
                excludedIds: new Set(),
                editingId: null,
                editingDraft: false,
                writerParse: null,
                workingCopyPath: null,
                signature: `sig-${pageNumber}`,
            });
            expect(paintInput.excludedIds.size).toBe(4);
        }
        expect(performance.now() - startedAt).toBeLessThan(300);
    });
});
