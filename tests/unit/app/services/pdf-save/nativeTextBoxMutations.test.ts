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
import {requireDocumentRevisionToken} from '@contracts';

function textBox(
    id: string,
    overrides: Partial<ITextBoxEntity> = {},
): ITextBoxEntity {
    return {
        kind: 'text-box',
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 1,
        persistedRevision: 0,
        deleted: false,
        createdAt: 1_781_000_000_000,
        modifiedAt: 1_781_000_000_100,
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
            pageIndex: 0,
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
            createdAt: 1_781_000_000_000,
            modifiedAt: 1_781_000_000_100,
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
            pageIndex: 0,
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
