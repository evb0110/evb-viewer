import {describe, expect, it} from 'vitest';
import {parseAgentResourceUri} from '@contracts/agentResourceUri';

describe('parseAgentResourceUri', () => {
    it('splits the host and decoded path segments of a document resource URI', () => {
        // Tab ids reach the URI percent-encoded, so a caller comparing the
        // segment against its own tab id only matches after decoding.
        const parsed = parseAgentResourceUri('evb://document/tab%201/annotations');

        expect(parsed).toEqual({
            uri: 'evb://document/tab%201/annotations',
            host: 'document',
            parts: ['tab 1', 'annotations'],
        });
    });

    it('reports an empty part list for a host-only workspace URI', () => {
        expect(parseAgentResourceUri('evb://workspace').parts).toEqual([]);
    });

    it('rejects a value that is not a URI at all', () => {
        expect(() => parseAgentResourceUri('not a uri')).toThrow('Invalid EVB resource URI: not a uri');
    });

    it('rejects a URI from another scheme', () => {
        expect(() => parseAgentResourceUri('https://document/tab-1/annotations')).toThrow('Unsupported EVB resource URI protocol: https:');
    });
});
