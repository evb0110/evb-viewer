import {
    describe,
    expect,
    it,
} from 'vitest';
import { SHELL_PLATFORM_FEATURE } from '@contracts/shellPlatformFeature';

describe('shell platform feature schemas', () => {
    const channels = SHELL_PLATFORM_FEATURE.invokeChannels;
    const codec = SHELL_PLATFORM_FEATURE.ipcCodecs[channels.openExternal]!;

    it('preserves the external-open invoke channel without an event layer', () => {
        expect(channels).toEqual({openExternal: 'shell:openExternal'});
        expect(SHELL_PLATFORM_FEATURE.eventChannels).toEqual({});
        expect(SHELL_PLATFORM_FEATURE.platformDescriptors.methods).toEqual([expect.objectContaining({
            kind: 'async',
            path: [
                'shell',
                'openExternal',
            ],
        })]);
    });

    it('normalizes and round-trips allowed external URLs', () => {
        expect(codec.decodeArgs([' https://example.test/path ']))
            .toEqual(['https://example.test/path']);
        expect(codec.decodeArgs(['mailto:reader@example.test']))
            .toEqual(['mailto:reader@example.test']);
        expect(codec.decodeResult(undefined)).toBeUndefined();
    });

    it('rejects malformed tuples and unsafe protocols', () => {
        expect(() => codec.decodeArgs([]))
            .toThrow('expected 1 arguments, received 0');
        expect(() => codec.decodeArgs(['file:///tmp/book.pdf']))
            .toThrow('Unsupported external URL protocol: file:');
        expect(() => codec.decodeArgs(['javascript:alert(1)']))
            .toThrow('Unsupported external URL protocol: javascript:');
        expect(() => codec.decodeResult(null))
            .toThrow('expected an undefined IPC result');
    });

    it('does not store an example factory in the production descriptor', () => {
        expect(SHELL_PLATFORM_FEATURE.fixtureMethods).toEqual([]);
        expect(codec.decodeResult(undefined)).toBeUndefined();
    });
});
