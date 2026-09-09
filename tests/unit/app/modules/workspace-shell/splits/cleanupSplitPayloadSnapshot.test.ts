import type * as TViMockOriginalModule from '@app/utils/platformDocuments';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requireDocumentRef } from '@contracts/documentRef';
import type { TSplitPayload } from '@contracts/windowTabs';
import { cleanupSplitPayloadSnapshot } from '@app/modules/workspace-shell/splits/cleanupSplitPayloadSnapshot';

const mocks = vi.hoisted(() => ({
    cleanupFile: vi.fn(),
    legacyCleanupFile: vi.fn(),
    loggerWarn: vi.fn(),
}));

vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentWorkingCopyCapability: () => ({ cleanupFile: mocks.cleanupFile }),
}));

vi.mock('@app/utils/browserLogger', () => ({ BrowserLogger: { warn: mocks.loggerWarn } }));

function pdfSnapshotPayload(): TSplitPayload {
    return {
        kind: 'pdfSnapshot',
        fileName: 'sample.pdf',
        originalPath: requireDocumentRef('/tmp/sample.pdf'),
        snapshotPath: requireDocumentRef('/tmp/snapshot.pdf'),
        isDirty: false,
    };
}

describe('cleanupSplitPayloadSnapshot', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.cleanupFile.mockResolvedValue(undefined);
        mocks.legacyCleanupFile.mockImplementation(() => {
            throw new Error('legacy cleanupFile should not be used');
        });
    });

    it('uses the split working copy capability for pdf snapshot cleanup', async () => {
        const cleaned = await cleanupSplitPayloadSnapshot(pdfSnapshotPayload(), {
            logSection: 'workspace',
            context: 'test-cleanup',
        });

        expect(cleaned).toBe(true);
        expect(mocks.cleanupFile).toHaveBeenCalledWith('/tmp/snapshot.pdf');
        expect(mocks.legacyCleanupFile).not.toHaveBeenCalled();
    });

    it('ignores non-snapshot payloads without touching working-copy cleanup', async () => {
        const cleaned = await cleanupSplitPayloadSnapshot({ kind: 'empty' }, {
            logSection: 'workspace',
            context: 'test-cleanup',
        });

        expect(cleaned).toBe(false);
        expect(mocks.cleanupFile).not.toHaveBeenCalled();
        expect(mocks.legacyCleanupFile).not.toHaveBeenCalled();
    });
});
