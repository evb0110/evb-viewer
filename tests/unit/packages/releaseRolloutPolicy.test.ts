import {describe, expect, it} from 'vitest';
import {normalizeCanaryPercent, parseReleaseTagList, selectReleaseForRollout} from '@releaseSelection';

const releases = [{tag_name: 'v3.0.0'}, {tag_name: 'v2.0.0'}, {tag_name: 'v1.0.0'}];

describe('release rollout policy', () => {
    it('uses preference-ordered stable tags for immediate rollback', () => {
        expect(
            selectReleaseForRollout(
                releases,
                {
                    canaryPercent: 0,
                    canaryTag: null,
                    stableTags: ['v2.0.0', 'v1.0.0'],
                    withdrawnTags: new Set(),
                },
                'cohort',
            )?.tag_name,
        ).toBe('v2.0.0');
    });

    it('never serves withdrawn releases', () => {
        expect(
            selectReleaseForRollout(
                releases,
                {
                    canaryPercent: 100,
                    canaryTag: 'v3.0.0',
                    stableTags: ['v2.0.0'],
                    withdrawnTags: new Set(['v3.0.0', 'v2.0.0']),
                },
                'cohort',
            ),
        ).toBeNull();
    });

    it('deterministically directs a configured cohort to a canary', () => {
        const policy = {
            canaryPercent: 100,
            canaryTag: 'v3.0.0',
            stableTags: ['v2.0.0'],
            withdrawnTags: new Set<string>(),
        };
        expect(selectReleaseForRollout(releases, policy, 'same-client')?.tag_name).toBe('v3.0.0');
        expect(
            selectReleaseForRollout(
                releases,
                {
                    ...policy,
                    canaryPercent: 0,
                },
                'same-client',
            )?.tag_name,
        ).toBe('v2.0.0');
    });

    it('normalizes operator configuration', () => {
        expect(parseReleaseTagList(' v2, v1, v2, ')).toEqual(['v2', 'v1']);
        expect(normalizeCanaryPercent('125')).toBe(100);
        expect(normalizeCanaryPercent('invalid')).toBe(0);
    });
});
