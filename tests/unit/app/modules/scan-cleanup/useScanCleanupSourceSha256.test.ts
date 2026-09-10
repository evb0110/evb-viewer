// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/utils/platformDocuments';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import {requireDocumentRef} from '@contracts/documentRef';
import {useScanCleanupSourceSha256} from '@app/modules/scan-cleanup/composables/useScanCleanupSourceSha256';

const files = vi.hoisted(() => ({
    createManagedTempFileHandle: vi.fn(),
    releaseManagedTempFileHandle: vi.fn(),
}));

vi.mock('@app/utils/platform', () => ({isDesktopPlatformActive: () => true}));
vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentFilesCapability: () => files,
}));

describe('scan cleanup source SHA-256 bridge', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        files.createManagedTempFileHandle.mockResolvedValue({
            path: '/working/book.pdf',
            size: 1,
            sha256: 'A'.repeat(64),
            leaseId: 'scan-cleanup-hash-lease',
            revision: null,
        });
        files.releaseManagedTempFileHandle.mockResolvedValue(true);
    });

    it('uses the main-owned managed-file hash and releases its lease', async () => {
        const enabled = ref(true);
        const sourcePath = ref(requireDocumentRef('/working/book.pdf'));
        const documentRevision = ref('revision-1');
        let sourceSha256: ReturnType<typeof useScanCleanupSourceSha256> | null = null;
        const host = document.createElement('div');
        const app = createApp(defineComponent({setup() {
            sourceSha256 = useScanCleanupSourceSha256({
                enabled,
                sourcePath,
                documentRevision,
            });
            return () => h('div');
        }}));
        app.mount(host);

        await vi.waitFor(() => expect(sourceSha256?.value).toBe('a'.repeat(64)));
        expect(files.createManagedTempFileHandle).toHaveBeenCalledWith('/working/book.pdf');
        expect(files.releaseManagedTempFileHandle).toHaveBeenCalledWith('scan-cleanup-hash-lease');

        app.unmount();
        host.remove();
    });

    it('retains the acquired hash while the source surface is disabled and re-enabled', async () => {
        const enabled = ref(true);
        const sourcePath = ref(requireDocumentRef('/working/book.pdf'));
        const documentRevision = ref('revision-1');
        let sourceSha256: ReturnType<typeof useScanCleanupSourceSha256> | null = null;
        const host = document.createElement('div');
        const app = createApp(defineComponent({setup() {
            sourceSha256 = useScanCleanupSourceSha256({
                enabled,
                sourcePath,
                documentRevision,
            });
            return () => h('div');
        }}));
        app.mount(host);
        const readSourceSha256 = () => (
            sourceSha256 as ReturnType<typeof useScanCleanupSourceSha256> | null
        )?.value;

        await vi.waitFor(() => expect(readSourceSha256()).toBe('a'.repeat(64)));
        enabled.value = false;
        await nextTick();
        expect(readSourceSha256()).toBe('a'.repeat(64));
        enabled.value = true;
        await nextTick();
        expect(readSourceSha256()).toBe('a'.repeat(64));
        expect(files.createManagedTempFileHandle).toHaveBeenCalledOnce();
        expect(files.releaseManagedTempFileHandle).toHaveBeenCalledOnce();

        app.unmount();
        host.remove();
    });
});
