import {IPC_INVOKE_REQUEST_ID_FIELD} from '@electron/platform-ipc/coreContract';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IpcRenderer } from 'electron';
import {requireEpochMs} from '@contracts/timestamps';
import {requireRequestId} from '@contracts/shared';
import type {TRequestId} from '@contracts/shared';
import { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
import { createPlatformFeaturePreloadClient } from '@electron/preload/ipcClient';
import {
    findSearchErrorEnvelope,
    type ISearchErrorEnvelope,
} from '@contracts/search';
import {encodeSerializableErrorEnvelope} from '@contracts/serializableError';

const SEARCH_CHANNELS = SEARCH_PLATFORM_FEATURE.invokeChannels;
type TTestIpcRenderer = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener' | 'send'>;

// This deliberately violates the request-id brand so the preload boundary guard is exercised.
const invalidRequestId = 'x'.repeat(129) as TRequestId;

describe('derived Search preload client', () => {
    it('normalizes search requests before invoking main', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => ({
                results: [],
                truncated: false,
            })),
            on: vi.fn(),
            removeListener: vi.fn(),
            send: vi.fn(),
        } satisfies TTestIpcRenderer;
        const client = createPlatformFeaturePreloadClient(ipcRenderer, SEARCH_PLATFORM_FEATURE);

        await client.run('  /tmp/work.pdf  ', 'needle', {
            requestId: requireRequestId('  search-1  '),
            pageCount: 12,
            matchCase: true,
            wholeWord: false,
            useRegex: false,
        });

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            SEARCH_CHANNELS.run,
            {
                pdfPath: '/tmp/work.pdf',
                query: 'needle',
                requestId: 'search-1',
                pageCount: 12,
                matchCase: true,
                wholeWord: false,
                useRegex: false,
            },
            {[IPC_INVOKE_REQUEST_ID_FIELD]: expect.any(String)},
        );
    });

    it('rejects invalid preload search requests before invoking main', async () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            on: vi.fn(),
            removeListener: vi.fn(),
            send: vi.fn(),
        } satisfies TTestIpcRenderer;
        const client = createPlatformFeaturePreloadClient(ipcRenderer, SEARCH_PLATFORM_FEATURE);

        expect(() => client.run('/tmp/work.pdf', 'needle', {requestId: invalidRequestId}))
            .toThrow('requestId exceeds maximum length (128)');
        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('recovers a typed search error after Electron preserves only Error.message', async () => {
        const envelope: ISearchErrorEnvelope = {
            code: 'SEARCH_PATH_DENIED',
            message: 'Search path denied',
            retryable: false,
            timestamp: requireEpochMs(123),
        };
        const cause = new Error(
            `Error invoking remote method '${SEARCH_CHANNELS.run}': ${encodeSerializableErrorEnvelope(envelope)}`,
        );
        const ipcRenderer = {
            invoke: vi.fn(async () => {
                throw cause;
            }),
            on: vi.fn(),
            removeListener: vi.fn(),
            send: vi.fn(),
        } satisfies TTestIpcRenderer;
        const client = createPlatformFeaturePreloadClient(ipcRenderer, SEARCH_PLATFORM_FEATURE);

        const error = await client.run('/tmp/work.pdf', 'needle').catch((caught: unknown) => caught);

        expect(error).toMatchObject({
            name: 'PlatformIpcInvokeError',
            channel: SEARCH_CHANNELS.run,
            cause,
        });
        expect(findSearchErrorEnvelope(error)).toEqual(envelope);
    });

    it('decodes structured envelopes but ignores unmarked JSON error messages', () => {
        const envelope: ISearchErrorEnvelope = {
            code: 'SEARCH_PATH_DENIED',
            message: 'Search path denied',
            retryable: false,
            timestamp: requireEpochMs(123),
        };

        expect(findSearchErrorEnvelope({errorEnvelope: envelope})).toEqual(envelope);
        expect(findSearchErrorEnvelope(new Error(JSON.stringify(envelope)))).toBeNull();
    });

});
