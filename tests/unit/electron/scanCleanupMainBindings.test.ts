import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {FEATURE_REGISTRATION_DESCRIPTORS} from '@electron/platform-ipc/featureRegistrationTable';
import {registerLazyPlatformFeature} from '@electron/platform-ipc/registerFeatureIpcAdapters';
import {disposeScanCleanupMainBindings} from '@electron/features/scan-cleanup/scanCleanupMainBindings';

const mocks = vi.hoisted(() => ({previewService: {dispose: vi.fn(async () => undefined)}}));

vi.mock('@electron/features/scan-cleanup/scanCleanupPreviewLifecycle', () => ({
    defaultDependencies: {},
    scanCleanupPreviewLifecycle: () => mocks.previewService,
}));
vi.mock('@electron/features/scan-cleanup/createScanCleanupService', () => ({createScanCleanupService: () => ({})}));
vi.mock('@electron/features/scan-cleanup/createScanCleanupSettingsStore', () => ({createScanCleanupSettingsStore: () => ({})}));
vi.mock('electron', () => ({app: {getPath: () => '/tmp/scan-cleanup-main-bindings-test'}}));

describe('scan-cleanup main binding lifecycle', () => {
    it('invokes the real binding disposer once across repeated shutdown calls', async () => {
        const first = disposeScanCleanupMainBindings();
        const second = disposeScanCleanupMainBindings();

        expect(second).toBe(first);
        await Promise.all([
            first,
            second,
        ]);
        expect(mocks.previewService.dispose).toHaveBeenCalledOnce();
    });

    it('does not load or dispose a lazy feature before it has been used', async () => {
        const disposer = vi.fn(async () => undefined);
        const scanCleanupDescriptor = FEATURE_REGISTRATION_DESCRIPTORS
            .find(descriptor => descriptor.name === 'scan-cleanup')!;
        const descriptor = {
            ...scanCleanupDescriptor,
            create: async () => ({disposeScanCleanupMainBindings: disposer}),
        } as never;
        const dispose = registerLazyPlatformFeature({handle(_channel: string, _handler: (...args: unknown[]) => unknown) {}} as Electron.IpcMain, descriptor, {agentService: {} as never});

        await expect(dispose()).resolves.toBeUndefined();
        expect(disposer).not.toHaveBeenCalled();
    });
});
