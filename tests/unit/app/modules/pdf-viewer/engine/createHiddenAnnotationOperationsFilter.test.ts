import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createHiddenAnnotationOperationsFilter } from '@app/modules/pdf-viewer/engine/pdf-hidden-annotation-operations/createHiddenAnnotationOperationsFilter';
import { cast } from '@tests/helpers/cast';

function createOperatorList() {
    return {
        fnArray: [80],
        argsArray: [['12R']],
    };
}

describe('createHiddenAnnotationOperationsFilter', () => {
    it('filters the complete managed annotation appearance block', async () => {
        const filter = await createHiddenAnnotationOperationsFilter(
            cast<IPdfPage>({
                pageNumber: 1,
                getOperatorList: vi.fn(async () => ({
                    fnArray: [
                        80,
                        10,
                        81,
                        80,
                        10,
                        81,
                    ],
                    argsArray: [
                        ['12R'],
                        [],
                        [],
                        ['13R'],
                        [],
                        [],
                    ],
                })),
            }),
            1,
            new Set(['12R']),
        );

        expect(filter).toBeTypeOf('function');
        expect([
            0,
            1,
            2,
            3,
            4,
            5,
        ].map(index => filter?.(index))).toEqual([
            false,
            false,
            false,
            true,
            true,
            true,
        ]);
    });

    it('fails closed when managed appearance suppression cannot be prepared', async () => {
        await expect(createHiddenAnnotationOperationsFilter(
            cast<IPdfPage>({
                pageNumber: 1,
                getOperatorList: vi.fn(async () => {
                    throw new Error('operator scan failed');
                }),
            }),
            1,
            new Set(['12R']),
        )).rejects.toThrow('operator scan failed');
    });

    it('does not start the coordinated operator-list scan when the render is stale', async () => {
        const getOperatorList = vi.fn(async () => createOperatorList());
        const filter = await createHiddenAnnotationOperationsFilter(
            cast<IPdfPage>({
                pageNumber: 1,
                getOperatorList,
            }),
            1,
            new Set(['12R']),
            {
                owner: 'viewer',
                priority: 100,
                shouldStart: () => false,
            },
        );

        expect(filter).toBeUndefined();
        expect(getOperatorList).not.toHaveBeenCalled();
    });

    it('drops a coordinated operator-list result when the render goes stale before completion', async () => {
        const getOperatorList = vi.fn(async () => createOperatorList());
        const filter = await createHiddenAnnotationOperationsFilter(
            cast<IPdfPage>({
                pageNumber: 1,
                getOperatorList,
            }),
            1,
            new Set(['12R']),
            {
                owner: 'viewer',
                priority: 100,
                shouldContinue: () => false,
            },
        );

        expect(filter).toBeUndefined();
        expect(getOperatorList).toHaveBeenCalledOnce();
    });
});
