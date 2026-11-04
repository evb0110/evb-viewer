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
                        assets: [
                            {name: 'package.deb'},
                            {name: 'package two.exe'},
                        ],
                    }
                    : {
                        release: {tag: 'v1.2.3'},
                        assets: [
                            {name: 'package.deb'},
                            {name: 'package two.exe'},
                        ],
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
        expect(requests.map(([url]) => url)).toHaveLength(5);
        expect(requests.slice(3).map(([
            url,
            init,
        ]) => [
            url.split('/').at(-1),
            init?.method,
        ])).toEqual([
            [
                'package.deb',
                'HEAD',
            ],
            [
                'package%20two.exe',
                'HEAD',
            ],
        ]);
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
                    assets: [
                        {name: 'package.deb'},
                        {name: 'package two.exe'},
                    ],
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
            'evb-viewer/drill/7/releases/v0.0.0-drill.7/package two.exe',
        ]);
    });

    it.each([
        200,
        404,
    ])('requires the second public asset, allowing a Range fallback (status=%s)', async (secondStatus) => {
        const attempts: Array<[string, RequestInit | undefined]> = [];
        const fetchFn: typeof fetch = async (url, init) => {
            const requestUrl = String(url);
            if (requestUrl.endsWith('stable.json')) return response({release: {tag: 'v1.2.3'}});
            if (requestUrl.endsWith('manifest.json')) return response({
                release: {tag: 'v1.2.3'},
                assets: [
                    {name: 'first.deb'},
                    {name: 'second.exe'},
                ],
            });
            attempts.push([
                requestUrl,
                init,
            ]);
            return response({}, requestUrl.endsWith('/second.exe') ? init?.method === 'HEAD' ? 405 : secondStatus : 200);
        };
        const verification = verifyMirrorObjects({
            tag: 'v1.2.3',
            fetchFn,
        });
        if (secondStatus === 200) await expect(verification).resolves.toMatchObject({publicRoute: true});
        else await expect(verification).rejects.toThrow('Mirror release asset second.exe returned HTTP 404');
        expect(attempts.map(([
            url,
            init,
        ]) => [
            url.split('/').at(-1),
            init,
        ])).toEqual([
            [
                'first.deb',
                {method: 'HEAD'},
            ],
            [
                'second.exe',
                {method: 'HEAD'},
            ],
            [
                'second.exe',
                {headers: {Range: 'bytes=0-0'}},
            ],
        ]);
    });

    it('rejects a drill mirror when its second object is missing', async () => {
        const keys: string[] = [];
        await expect(verifyMirrorObjects({
            tag: 'v0.0.0-drill.7',
            drillRunId: '7',
            fetchFn: async () => response({}, 404),
            createMirrorClientFn: () => ({
                bucket: 'bucket',
                client: {send: async (command: {input: {Key: string}}) => {
                    const key = command.input.Key;
                    keys.push(key);
                    if (key.endsWith('/stable.json')) return {Body: {transformToString: async () => JSON.stringify({release: {tag: 'v0.0.0-drill.7'}})}};
                    if (key.endsWith('/manifest.json')) return {Body: {transformToString: async () => JSON.stringify({
                        release: {tag: 'v0.0.0-drill.7'},
                        assets: [
                            {name: 'first.deb'},
                            {name: 'second.exe'},
                        ],
                    })}};
                    if (key.endsWith('/second.exe')) throw new Error('NoSuchKey: second.exe');
                    return {};
                }},
            }) as never,
        })).rejects.toThrow('NoSuchKey: second.exe');
        expect(keys.slice(-2)).toEqual([
            'evb-viewer/drill/7/releases/v0.0.0-drill.7/first.deb',
            'evb-viewer/drill/7/releases/v0.0.0-drill.7/second.exe',
        ]);
    });

});
