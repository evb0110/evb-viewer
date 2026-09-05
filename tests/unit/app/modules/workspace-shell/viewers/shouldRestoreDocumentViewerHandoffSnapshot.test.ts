import {
    describe,
    expect,
    it,
} from 'vitest';
import { shouldRestoreDocumentViewerHandoffSnapshot } from '@app/modules/workspace-shell/viewers/shouldRestoreDocumentViewerHandoffSnapshot';

describe('document viewer handoff snapshot ownership', () => {
    it('does not restore the old page after navigation changed the chassis page', () => {
        expect(shouldRestoreDocumentViewerHandoffSnapshot({
            fallbackPage: 1,
            currentPage: 25,
            pendingNavigationPage: null,
        })).toBe(false);
    });

    it('does not restore the old page while a navigation target is pending', () => {
        expect(shouldRestoreDocumentViewerHandoffSnapshot({
            fallbackPage: 1,
            currentPage: 1,
            pendingNavigationPage: 25,
        })).toBe(false);
    });

    it('restores the snapshot when no newer navigation owns the viewport', () => {
        expect(shouldRestoreDocumentViewerHandoffSnapshot({
            fallbackPage: 1,
            currentPage: 1,
            pendingNavigationPage: null,
        })).toBe(true);
    });
});
