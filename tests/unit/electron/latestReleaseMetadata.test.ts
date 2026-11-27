import {describe, expect, it} from 'vitest';
import {decodeLatestReleaseTag} from '@electron/updates/decodeLatestReleaseTag';

describe('decodeLatestReleaseTag', () => {
    it('reconstructs the release tag from valid update metadata', () => {
        expect(
            decodeLatestReleaseTag({
                release: {
                    tag: 'v1.2.3',
                    ignored: true,
                },
                ignored: true,
            }),
        ).toBe('v1.2.3');
    });

    it.each([null, [], {}, {release: null}, {release: []}, {release: {}}, {release: {tag: 123}}])(
        'rejects malformed update metadata (%j)',
        (value) => {
            expect(decodeLatestReleaseTag(value)).toBeNull();
        },
    );
});
