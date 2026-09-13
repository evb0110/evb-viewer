import {
    describe,
    expect,
    it,
} from 'vitest';
import { createDocumentOpenGenerationErrorLatch } from '@app/modules/document-viewer/chassis/createDocumentOpenGenerationErrorLatch';

describe('createDocumentOpenGenerationErrorLatch', () => {
    it('lets a late success clear the same generation terminal error', () => {
        const latch = createDocumentOpenGenerationErrorLatch();
        latch.recordFailure(7);

        expect(latch.consumeMatchingSuccess(7)).toBe(true);
        expect(latch.consumeMatchingSuccess(7)).toBe(false);
    });

    it('does not let a superseding generation clear an earlier error', () => {
        const latch = createDocumentOpenGenerationErrorLatch();
        latch.recordFailure(7);

        expect(latch.consumeMatchingSuccess(8)).toBe(false);
        expect(latch.consumeMatchingSuccess(7)).toBe(true);
    });
});
