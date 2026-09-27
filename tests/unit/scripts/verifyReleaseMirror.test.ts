import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    verify, verifyMirrorObjects,
} from '@scripts/release/verifyReleaseMirror.mjs';

function response(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {status});
}

describe('public release mirror verification', () => {
    it('requires GitHub latest, the updater channel and a served release asset to match', async () => {
        const requests: Array<[string, RequestInit | undefined]> = [];
        const fetchFn: typeof fetch = async (url, init) => {
            const requestUrl = url instanceof Request ? url.url : String(url);
            requests.push([
                requestUrl,
                init,
            ]);
            const value = requestUrl.includes('/releases/latest')
                ? {tag_name: 'v1.2.3'}
                : requestUrl.endsWith('/manifest.json')
                    ? {
                        release: {tag: 'v1.2.3'},
                        assets: [{name: 'package.deb'}],
                    }
                    : {
                        release: {tag: 'v1.2.3'},
                        assets: [{name: 'package.deb'}],
                    };
            return response(value);
        };

        await expect(verify('v1.2.3', {
            repository: 'owner/repo',
            fetchFn,
        })).resolves.toMatchObject({
            publicRoute: true,
            tag: 'v1.2.3',
        });
        expect(requests.map(([url]) => url)).toHaveLength(4);
        expect(requests[3]?.[1]?.method).toBe('HEAD');
    });

    it('reads an unserved drill prefix through the mirror client', async () => {
        const keys: string[] = [];
        const fetchFn: typeof fetch = async () => response({}, 404);
        const client = {send: async (command: {input: {Key: string}}) => {
            keys.push(command.input.Key);
            if (command.input.Key.endsWith('/stable.json')) {
                return {Body: {transformToString: async () => JSON.stringify({release: {tag: 'v0.0.0-drill.7'}})}};
            }
            if (command.input.Key.endsWith('/manifest.json')) {
                return {Body: {transformToString: async () => JSON.stringify({
                    release: {tag: 'v0.0.0-drill.7'},
                    assets: [{name: 'package.deb'}],
                })}};
            }
            return {};
        }};

        await expect(verifyMirrorObjects({
            tag: 'v0.0.0-drill.7',
            drillRunId: '7',
            fetchFn,
            createMirrorClientFn: () => ({
                bucket: 'bucket',
                client,
            }) as never,
        })).resolves.toMatchObject({
            publicRoute: false,
            tag: 'v0.0.0-drill.7',
        });
        expect(keys).toEqual([
            'evb-viewer/drill/7/channels/stable.json',
            'evb-viewer/drill/7/releases/v0.0.0-drill.7/manifest.json',
            'evb-viewer/drill/7/releases/v0.0.0-drill.7/package.deb',
        ]);
    });
});
