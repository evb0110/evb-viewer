import {getPerformanceProfile, type IPerformanceProfile} from '@app/utils/performanceProfile';

export type TStartupWorkTier = 'low' | 'medium' | 'high';

export type TDesktopViewerWarmupStrategy = 'skip' | 'staged' | 'eager';

export interface IStartupWorkProfile {
    tier: TStartupWorkTier;
    desktopViewerWarmupStrategy: TDesktopViewerWarmupStrategy;
    recentGeometryCandidateLimit: number;
    recentGeometryConcurrency: number;
}

export function resolveStartupWorkProfile(
    performanceProfile: Pick<IPerformanceProfile, 'tier'> = getPerformanceProfile(),
): IStartupWorkProfile {
    if (performanceProfile.tier === 'low') {
        return {
            tier: 'low',
            desktopViewerWarmupStrategy: 'skip',
            recentGeometryCandidateLimit: 1,
            recentGeometryConcurrency: 1,
        };
    }
    if (performanceProfile.tier === 'medium') {
        return {
            tier: 'medium',
            desktopViewerWarmupStrategy: 'staged',
            recentGeometryCandidateLimit: 2,
            recentGeometryConcurrency: 1,
        };
    }
    return {
        tier: 'high',
        desktopViewerWarmupStrategy: 'eager',
        recentGeometryCandidateLimit: 4,
        recentGeometryConcurrency: 2,
    };
}
