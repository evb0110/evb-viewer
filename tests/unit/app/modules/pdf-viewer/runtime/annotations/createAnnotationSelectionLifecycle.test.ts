import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IAnnotationTextSelectionSnapshot} from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationTextSelectionCache';
import {createAnnotationSelectionLifecycle} from '@app/modules/pdf-viewer/runtime/annotations/createAnnotationSelectionLifecycle';

function selection(revision: number): IAnnotationTextSelectionSnapshot {
    return {
        range: {} as Range,
        revision,
    };
}

function style() {
    return {
        color: '#ffff00',
        opacity: 0.35,
    };
}

describe('createAnnotationSelectionLifecycle', () => {
    it.each([
        [
            'highlight',
            'Highlight',
        ],
        [
            'underline',
            'Underline',
        ],
        [
            'strikethrough',
            'StrikeOut',
        ],
        [
            'squiggly',
            'Squiggly',
        ],
    ] as const)('activates %s with its captured subtype', async (tool, subtype) => {
        const create = vi.fn(async (request: {subtype: string}) => ({
            status: 'created' as const,
            annotationId: request.subtype,
        }));
        const lifecycle = createAnnotationSelectionLifecycle({
            getActiveTool: () => tool,
            create,
            consumeSelection: vi.fn(),
        });

        await expect(lifecycle.activate({
            selection: selection(1),
            tool,
            subtype,
            style: style(),
            withNote: false,
        })).resolves.toMatchObject({status: 'created'});
        expect(create).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                tool,
                subtype,
            }),
            expect.any(Function),
        );
    });

    it('deduplicates activation and an explicit command for one selection', async () => {
        const deferred = Promise.withResolvers<{
            status: 'created';
            annotationId: string;
        }>();
        const create = vi.fn(async () => deferred.promise);
        const consumeSelection = vi.fn();
        const lifecycle = createAnnotationSelectionLifecycle({
            getActiveTool: () => 'highlight',
            create,
            consumeSelection,
        });
        const request = {
            selection: selection(2),
            tool: 'highlight' as const,
            subtype: 'Highlight' as const,
            style: style(),
            withNote: false,
        };

        const activation = lifecycle.activate(request);
        const explicit = lifecycle.request({
            ...request,
            requireActiveTool: true,
        });
        expect(explicit).toBe(activation);
        expect(create).toHaveBeenCalledOnce();

        deferred.resolve({
            status: 'created',
            annotationId: 'annotation-1',
        });
        await expect(activation).resolves.toMatchObject({status: 'created'});
        expect(consumeSelection).toHaveBeenCalledExactlyOnceWith(request.selection);
    });

    it('cancels a pending activation when the user switches to another tool', async () => {
        let activeTool: 'highlight' | 'select' = 'highlight';
        const deferred = Promise.withResolvers<undefined>();
        const create = vi.fn(async (_request, isRequestCurrent: () => boolean) => {
            await deferred.promise;
            return isRequestCurrent()
                ? {
                    status: 'created' as const,
                    annotationId: 'too-late',
                }
                : {status: 'cancelled' as const};
        });
        const consumeSelection = vi.fn();
        const lifecycle = createAnnotationSelectionLifecycle({
            getActiveTool: () => activeTool,
            create,
            consumeSelection,
        });

        const pending = lifecycle.activate({
            selection: selection(3),
            tool: 'highlight',
            subtype: 'Highlight',
            style: style(),
            withNote: false,
        });
        activeTool = 'select';
        deferred.resolve(undefined);

        await expect(pending).resolves.toEqual({status: 'cancelled'});
        expect(consumeSelection).not.toHaveBeenCalled();
    });

    it('keeps the old request cancelled and allows reactivation after returning to the same mode', async () => {
        let activeTool: 'highlight' | 'select' = 'highlight';
        const stale = Promise.withResolvers<undefined>();
        const current = Promise.withResolvers<undefined>();
        const create = vi.fn()
            .mockImplementationOnce(async (_request, isRequestCurrent: () => boolean) => {
                await stale.promise;
                return isRequestCurrent()
                    ? {
                        status: 'created' as const,
                        annotationId: 'stale',
                    }
                    : {status: 'cancelled' as const};
            })
            .mockImplementationOnce(async (_request, isRequestCurrent: () => boolean) => {
                await current.promise;
                return isRequestCurrent()
                    ? {
                        status: 'created' as const,
                        annotationId: 'current',
                    }
                    : {status: 'cancelled' as const};
            });
        const consumeSelection = vi.fn();
        const lifecycle = createAnnotationSelectionLifecycle({
            getActiveTool: () => activeTool,
            create,
            consumeSelection,
        });

        const request = {
            selection: selection(6),
            tool: 'highlight',
            subtype: 'Highlight',
            style: style(),
            withNote: false,
        } as const;
        const pending = lifecycle.activate(request);
        activeTool = 'select';
        lifecycle.invalidateActiveRequests();
        activeTool = 'highlight';
        lifecycle.invalidateActiveRequests();
        const reactivated = lifecycle.activate(request);

        expect(reactivated).not.toBe(pending);
        expect(create).toHaveBeenCalledTimes(2);

        current.resolve(undefined);
        await expect(reactivated).resolves.toMatchObject({
            status: 'created',
            annotationId: 'current',
        });
        stale.resolve(undefined);
        await expect(pending).resolves.toEqual({status: 'cancelled'});
        expect(consumeSelection).toHaveBeenCalledExactlyOnceWith(request.selection);

    });

    it('lets a newer selection finish without deduplicating it with the older one', async () => {
        const first = Promise.withResolvers<{
            status: 'created';
            annotationId: string;
        }>();
        const second = Promise.withResolvers<{
            status: 'created';
            annotationId: string;
        }>();
        const create = vi.fn()
            .mockImplementationOnce(async () => first.promise)
            .mockImplementationOnce(async () => second.promise);
        const consumeSelection = vi.fn();
        const lifecycle = createAnnotationSelectionLifecycle({
            getActiveTool: () => 'highlight',
            create,
            consumeSelection,
        });
        const base = {
            tool: 'highlight' as const,
            subtype: 'Highlight' as const,
            style: style(),
            withNote: false,
        };
        const older = lifecycle.activate({
            selection: selection(4),
            ...base,
        });
        const newer = lifecycle.activate({
            selection: selection(5),
            ...base,
        });

        first.resolve({
            status: 'created',
            annotationId: 'older',
        });
        second.resolve({
            status: 'created',
            annotationId: 'newer',
        });
        await expect(older).resolves.toMatchObject({annotationId: 'older'});
        await expect(newer).resolves.toMatchObject({annotationId: 'newer'});
        expect(create).toHaveBeenCalledTimes(2);
        expect(consumeSelection).toHaveBeenNthCalledWith(1, selection(4));
        expect(consumeSelection).toHaveBeenNthCalledWith(2, selection(5));
    });
});
