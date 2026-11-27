import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({getPerformanceProfile: vi.fn(() => ({tier: 'medium' as const}))}));

vi.mock('@app/utils/performanceProfile', () => ({getPerformanceProfile: mocks.getPerformanceProfile}));

describe('resolveStartupWorkProfile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        {
            tier: 'low' as const,
            expected: {
                tier: 'low',
                desktopViewerWarmupStrategy: 'skip',
                recentGeometryCandidateLimit: 1,
                recentGeometryConcurrency: 1,
            },
        },
        {
            tier: 'medium' as const,
            expected: {
                tier: 'medium',
                desktopViewerWarmupStrategy: 'staged',
                recentGeometryCandidateLimit: 2,
                recentGeometryConcurrency: 1,
            },
        },
        {
            tier: 'high' as const,
            expected: {
                tier: 'high',
                desktopViewerWarmupStrategy: 'eager',
                recentGeometryCandidateLimit: 4,
                recentGeometryConcurrency: 2,
            },
        },
    ])('maps the canonical $tier tier', async ({tier, expected}) => {
        const {resolveStartupWorkProfile} = await import('@app/utils/startupWorkProfile');

        expect(resolveStartupWorkProfile({tier})).toEqual(expected);
    });

    it('uses the cached canonical performance profile by default', async () => {
        const {resolveStartupWorkProfile} = await import('@app/utils/startupWorkProfile');

        expect(resolveStartupWorkProfile()).toMatchObject({
            tier: 'medium',
            desktopViewerWarmupStrategy: 'staged',
        });
        expect(mocks.getPerformanceProfile).toHaveBeenCalledOnce();
    });
});
