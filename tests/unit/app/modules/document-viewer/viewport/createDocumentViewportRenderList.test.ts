import {
    describe,
    expect,
    it,
} from 'vitest';
import { createDocumentViewportRenderList } from '@app/modules/document-viewer/viewport/createDocumentViewportRenderList';

describe('createDocumentViewportRenderList', () => {
    it('prefetches around the visible window and prioritizes forward scroll direction', () => {
        expect(createDocumentViewportRenderList({
            anchorPage: 10,
            direction: 1,
            endPage: 12,
            prefetchPages: 2,
            startPage: 8,
            totalPages: 20,
        })).toEqual([
            10,
            11,
            9,
            12,
            13,
            14,
            8,
            7,
            6,
        ]);
    });

    it('prioritizes previous pages while scrolling upward', () => {
        expect(createDocumentViewportRenderList({
            anchorPage: 10,
            direction: -1,
            endPage: 12,
            prefetchPages: 2,
            startPage: 8,
            totalPages: 20,
        })).toEqual([
            10,
            9,
            11,
            8,
            7,
            6,
            12,
            13,
            14,
        ]);
    });

    it('balances both sides when scroll direction is unknown', () => {
        expect(createDocumentViewportRenderList({
            anchorPage: 10,
            direction: 0,
            endPage: 12,
            prefetchPages: 2,
            startPage: 8,
            totalPages: 20,
        })).toEqual([
            10,
            11,
            9,
            12,
            8,
            13,
            7,
            14,
            6,
        ]);
    });

    it('can prefetch farther along the projected scroll direction', () => {
        expect(createDocumentViewportRenderList({
            anchorPage: 10,
            direction: 1,
            directionalPrefetchPages: 4,
            endPage: 12,
            prefetchPages: 1,
            startPage: 8,
            totalPages: 20,
        })).toEqual([
            10,
            11,
            9,
            12,
            13,
            14,
            15,
            16,
            8,
            7,
        ]);
    });
});
