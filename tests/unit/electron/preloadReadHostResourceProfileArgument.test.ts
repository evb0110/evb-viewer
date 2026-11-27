import {afterEach, describe, expect, it} from 'vitest';
import {HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX, type IHostResourceProfileSnapshot} from '@contracts/hostResourceProfile';

const originalBufferFrom = Buffer.from;
const originalBufferToString = Buffer.prototype.toString;

function installBase64OnlyBuffer() {
    Object.defineProperty(Buffer, 'from', {
        configurable: true,
        value: function from(value: unknown, encoding?: BufferEncoding) {
            if (encoding === 'base64url') {
                throw new Error('sandbox Buffer does not implement base64url');
            }
            // Only the string overload of Buffer.from takes an encoding, so the two
            // arities are forwarded separately rather than through one widened call.
            return typeof value === 'string' ? originalBufferFrom(value, encoding) : originalBufferFrom(value as Uint8Array);
        },
    });
    Object.defineProperty(Buffer.prototype, 'toString', {
        configurable: true,
        value: function toString(encoding?: BufferEncoding, start?: number, end?: number) {
            if (encoding === 'base64url') {
                throw new Error('sandbox Buffer does not implement base64url');
            }
            return originalBufferToString.call(this, encoding, start, end);
        },
    });
}

afterEach(() => {
    Object.defineProperty(Buffer, 'from', {
        configurable: true,
        value: originalBufferFrom,
    });
    Object.defineProperty(Buffer.prototype, 'toString', {
        configurable: true,
        value: originalBufferToString,
    });
});

describe('readHostResourceProfileArgument', () => {
    it('decodes a valid profile with the sandbox Buffer base64 API', async () => {
        const resourceProfile = {
            logicalCpus: 8,
            totalRamBytes: 16 * 1024 ** 3,
            safeMode: false,
            gpuStatus: {webgl: 'enabled'},
            detectedTier: 'high',
            performanceMode: 'low',
            tier: 'low',
        } satisfies IHostResourceProfileSnapshot;
        const encodedProfile = Buffer.from(JSON.stringify(resourceProfile), 'utf8').toString('base64url');

        installBase64OnlyBuffer();
        const {readHostResourceProfileArgument} = await import('@electron/preload/readHostResourceProfileArgument');

        expect(readHostResourceProfileArgument(['electron', `${HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX}${encodedProfile}`])).toEqual(
            resourceProfile,
        );
    });
});
