import {
    describe,
    expect,
    it,
} from 'vitest';
import { createDocumentViewerActivationRunGuard } from '@app/modules/document-viewer/lifecycle/createDocumentViewerActivationRunGuard';

describe('document viewer activation run guard', () => {
    it('invalidates stale resume work and requires an operational viewer', () => {
        let operational = true;
        const guard = createDocumentViewerActivationRunGuard(() => operational);
        const first = guard.begin();

        expect(guard.isCurrent(first)).toBe(true);
        const second = guard.begin();
        expect(guard.isCurrent(first)).toBe(false);
        expect(guard.isCurrent(second)).toBe(true);

        operational = false;
        expect(guard.isCurrent(second)).toBe(false);
    });
});
