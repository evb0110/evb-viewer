import {describe, expect, it, vi} from 'vitest';

const platformApiMock = vi.hoisted(() => ({system: {source: 'system'}}));

vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platformApiMock}));

const {getSystemCapability} = await import('@app/utils/getSystemCapability');

describe('platform capability getters', () => {
    it('falls back to unavailable system memory info when a narrow platform mock omits system', () => {
        const originalSystem = platformApiMock.system;
        try {
            (platformApiMock as {system?: unknown}).system = undefined;

            expect(getSystemCapability().getMemoryInfo()).toBeNull();
        } finally {
            platformApiMock.system = originalSystem;
        }
    });
});
