import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    hasDocumentMountHint,
    resolveWorkspaceRequestedState,
    shouldAutoRequestWorkspace,
} from '@app/composables/page/workspace-host-mounting';

describe('hasDocumentMountHint', () => {
    it('returns false for placeholder tabs', () => {
        expect(hasDocumentMountHint({
            fileName: null,
            originalPath: null,
            isDjvu: false,
        })).toBe(false);
    });

    it('returns true when file name exists', () => {
        expect(hasDocumentMountHint({
            fileName: 'invoice.pdf',
            originalPath: null,
            isDjvu: false,
        })).toBe(true);
    });

    it('returns true when original path exists', () => {
        expect(hasDocumentMountHint({
            fileName: null,
            originalPath: '/docs/invoice.pdf',
            isDjvu: false,
        })).toBe(true);
    });

    it('returns true when tab is in DjVu mode', () => {
        expect(hasDocumentMountHint({
            fileName: null,
            originalPath: null,
            isDjvu: true,
        })).toBe(true);
    });
});

describe('workspace host mount request state', () => {
    it('requests mount when split restore is queued', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: true,
            hasDocumentHint: false,
        })).toBe(true);
    });

    it('requests mount when a document hint exists', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
        })).toBe(true);
    });

    it('keeps request latched after signals clear', () => {
        const requested = resolveWorkspaceRequestedState(true, {
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
        });
        expect(requested).toBe(true);
    });

    it('stays false when not requested and no signals are present', () => {
        const requested = resolveWorkspaceRequestedState(false, {
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
        });
        expect(requested).toBe(false);
    });
});
