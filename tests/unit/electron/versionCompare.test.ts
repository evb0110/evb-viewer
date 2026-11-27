import {describe, expect, it} from 'vitest';
import {compareVersions, normalizeVersion} from '@electron/updates/versionCompare';

describe('versionCompare', () => {
    it('normalizes tags while preserving prerelease identifiers', () => {
        expect(normalizeVersion('v1.2.3-beta.1+build.7')).toBe('1.2.3-beta.1');
    });

    it.each([
        ['1.2.0-beta.1', '1.2.0-beta.2'],
        ['1.2.0-beta.2', '1.2.0-beta.10'],
        ['1.2.0-alpha.1', '1.2.0-beta.1'],
        ['1.2.0-beta', '1.2.0'],
        ['1.2.0', '1.2.1-beta.1'],
    ])('orders %s before %s', (left, right) => {
        expect(compareVersions(left, right)).toBeLessThan(0);
        expect(compareVersions(right, left)).toBeGreaterThan(0);
    });

    it('ignores build metadata for precedence', () => {
        expect(compareVersions('1.2.0+build.1', '1.2.0+build.2')).toBe(0);
    });
});
