import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {FEATURE_REGISTRATION_DESCRIPTORS} from '@electron/platform-ipc/featureRegistrationTable';
import {registerLazyPlatformFeature} from '@electron/platform-ipc/registerFeatureIpcAdapters';
import {createScanCleanupMainBindingsDisposer} from '@electron/features/scan-cleanup/createScanCleanupMainBindingsDisposer';

describe('scan-cleanup main binding lifecycle', () => {
    it('wires the idempotent disposer into the real lazy binding export', () => {
        const source = readFileSync(resolve(
            process.cwd(),
            'electron/features/scan-cleanup/scanCleanupMainBindings.ts',
        ), 'utf8');

        expect(source).toMatch(/createScanCleanupMainBindingsDisposer\(previewService\)/u);
        expect(source).toMatch(/export function disposeScanCleanupMainBindings\(\)/u);
        expect(source).toMatch(/Object\.assign\(featureBindings, \{disposeScanCleanupMainBindings\}\)/u);
    });

    it('retains the real binding disposer and invokes it once across shutdown calls', async () => {
        const disposePreview = vi.fn(async () => undefined);
        const disposeScanCleanupMainBindings = createScanCleanupMainBindingsDisposer({dispose: disposePreview});

        const first = disposeScanCleanupMainBindings();
        const second = disposeScanCleanupMainBindings();

        expect(second).toBe(first);
        await Promise.all([
            first,
            second,
        ]);
        expect(disposePreview).toHaveBeenCalledOnce();
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
