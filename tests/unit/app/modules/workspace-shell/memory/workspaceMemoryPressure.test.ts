import {describe, expect, it} from 'vitest';
import {resolveWorkspaceResourcePressureLevel} from '@app/modules/workspace-shell/memory/resolveWorkspaceResourcePressureLevel';

describe('workspace memory pressure', () => {
    const sample = (availableBytes: number) =>
        resolveWorkspaceResourcePressureLevel({
            memoryInfo: {
                availableBytes,
                totalBytes: 8_000,
                freeBytes: availableBytes,
            },
            systemFreeReserveBytes: 1_000,
        });

    it('resolves three levels from host headroom against the free-memory reserve', () => {
        expect(sample(2_000)).toBe('none');
        expect(sample(1_000)).toBe('none');
        expect(sample(999)).toBe('moderate');
        expect(sample(501)).toBe('moderate');
        expect(sample(500)).toBe('critical');
        expect(sample(0)).toBe('critical');
    });

    it('reports no pressure when the host does not report memory', () => {
        expect(
            resolveWorkspaceResourcePressureLevel({
                memoryInfo: null,
                systemFreeReserveBytes: 1_000,
            }),
        ).toBe('none');
    });

    it('uses reclaimable host memory instead of raw free pages', () => {
        expect(
            resolveWorkspaceResourcePressureLevel({
                memoryInfo: {
                    availableBytes: 6_000,
                    totalBytes: 8_000,
                    freeBytes: 100,
                },
                systemFreeReserveBytes: 1_000,
            }),
        ).toBe('none');
    });
});
