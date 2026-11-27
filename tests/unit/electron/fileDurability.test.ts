import {describe, expect, it, vi} from 'vitest';
import {syncFileHandleForDurability} from '@electron/utils/syncFileHandleForDurability';

describe('syncFileHandleForDurability', () => {
    it.each(['EPERM', 'EINVAL'] as const)('allows Windows atomic publication to continue after %s', async (code) => {
        const error = Object.assign(new Error(`operation not permitted, fsync (${code})`), {code});
        const onSkipped = vi.fn();

        await expect(
            syncFileHandleForDurability({sync: vi.fn().mockRejectedValue(error)} as never, {
                platform: 'win32',
                onSkipped,
            }),
        ).resolves.toBeUndefined();
        expect(onSkipped).toHaveBeenCalledWith(error);
    });

    it.each([
        ['darwin', 'EPERM'],
        ['linux', 'EINVAL'],
        ['win32', 'EIO'],
    ] as const)('keeps %s %s failures fatal', async (platform, code) => {
        const error = Object.assign(new Error(`fsync failed (${code})`), {code});

        await expect(syncFileHandleForDurability({sync: vi.fn().mockRejectedValue(error)} as never, {platform})).rejects.toBe(error);
    });
});
