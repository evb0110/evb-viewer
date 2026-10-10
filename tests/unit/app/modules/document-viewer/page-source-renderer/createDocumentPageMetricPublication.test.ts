import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createDocumentPageMetricPublication } from '@app/modules/document-viewer/page-source-renderer/createDocumentPageMetricPublication';
import { createProvisionalDocumentPageMetrics } from '@app/modules/document-viewer/page-source-renderer/loadPrioritizedDocumentPageMetrics';

const metric = (widthPoints: number) => ({
    widthPoints,
    heightPoints: 200,
    rotation: 0 as const,
});

describe('createDocumentPageMetricPublication', () => {
    it('publishes multiple exact metrics in one frame geometry commit', () => {
        const frame: {callback: FrameRequestCallback | null} = {callback: null};
        const environment = {
            requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
                frame.callback = callback;
                return 1;
            }),
            cancelAnimationFrame: vi.fn(),
        };
        const committed: unknown[] = [];
        const onPublished = vi.fn();
        const publication = createDocumentPageMetricPublication({
            readMetrics: () => [
                metric(100),
                metric(100),
                metric(100),
            ],
            commitMetrics: metrics => committed.push(metrics),
            onPublished,
        }, environment);

        publication.enqueue(1, metric(101));
        publication.enqueue(3, metric(303));
        expect(committed).toHaveLength(0);

        expect(frame.callback).not.toBeNull();
        if (!frame.callback) {
            throw new Error('Publication frame was not scheduled');
        }
        frame.callback(0);

        expect(committed).toEqual([[
            metric(101),
            metric(100),
            metric(303),
        ]]);
        expect(onPublished).toHaveBeenCalledOnce();
    });

    it('merges a far-page update without slicing a sparse document collection', () => {
        const frame: {callback: FrameRequestCallback | null} = {callback: null};
        const environment = {
            requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
                frame.callback = callback;
                return 1;
            }),
            cancelAnimationFrame: vi.fn(),
        };
        const metrics = createProvisionalDocumentPageMetrics(1_000_000, metric(100));
        const committed: unknown[] = [];
        const publication = createDocumentPageMetricPublication({
            readMetrics: () => metrics,
            commitMetrics: nextMetrics => committed.push(nextMetrics),
            onPublished: vi.fn(),
        }, environment);

        publication.enqueue(1_000_000, metric(999));
        if (!frame.callback) {
            throw new Error('Publication frame was not scheduled');
        }
        frame.callback(0);

        expect(committed).toEqual([metrics]);
        expect(metrics[999_999]).toEqual(metric(999));
        expect(Object.keys(metrics).filter(key => /^\d+$/.test(key))).toEqual([]);
    });
});
