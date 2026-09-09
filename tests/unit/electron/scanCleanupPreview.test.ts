import {
    expectTypeOf,
    it,
} from 'vitest';
import {scanCleanupPreviewLifecycle} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import type {IScanCleanupPreviewDependencies} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';

it('exposes the typed composition dependency contract', () => {
    expectTypeOf(scanCleanupPreviewLifecycle)
        .parameter(0)
        .toMatchTypeOf<IScanCleanupPreviewDependencies>();
});
