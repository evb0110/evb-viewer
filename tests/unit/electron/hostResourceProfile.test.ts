import {beforeEach, describe, expect, it, vi} from 'vitest';
import {PROCESS_SAFE_MODE_ARGUMENT} from '@electron/processDeathRecovery';
import {HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX, decodeHostResourceProfileSnapshot} from '@contracts/hostResourceProfile';

const GIB = 1024 ** 3;

describe('main host resource profile', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('captures CPU, RAM, safe mode, and frozen GPU state once', async () => {
        const {encodeHostResourceProfileArgument, getHostResourceProfileSnapshot, initializeHostResourceProfile} =
            await import('@electron/resources/hostResourceProfile');
        const gpuStatus = {
            gpu_compositing: 'enabled',
            webgl: 'enabled',
        };
        const snapshot = initializeHostResourceProfile({
            app: {getGPUFeatureStatus: vi.fn(() => gpuStatus)} as never,
            argv: ['electron', PROCESS_SAFE_MODE_ARGUMENT],
            availableParallelism: vi.fn(() => 8),
            cpus: vi.fn(() => Array.from({length: 2})),
            totalmem: vi.fn(() => 16 * GIB),
            performanceMode: 'auto',
        });

        expect(snapshot).toEqual({
            logicalCpus: 8,
            totalRamBytes: 16 * GIB,
            safeMode: true,
            gpuStatus,
            detectedTier: 'high',
            performanceMode: 'auto',
            tier: 'high',
        });
        expect(getHostResourceProfileSnapshot()).toBe(snapshot);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.gpuStatus)).toBe(true);

        const encodedArgument = encodeHostResourceProfileArgument(snapshot);
        expect(encodedArgument).toMatch(new RegExp(`^${HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX}`));
        const encodedSnapshot = encodedArgument.slice(HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX.length);
        expect(decodeHostResourceProfileSnapshot(JSON.parse(Buffer.from(encodedSnapshot, 'base64url').toString('utf8')))).toEqual(snapshot);
    });

    it('falls back to the CPU list and omits failed GPU capture', async () => {
        const {initializeHostResourceProfile} = await import('@electron/resources/hostResourceProfile');
        const snapshot = initializeHostResourceProfile({
            app: {
                getGPUFeatureStatus: vi.fn(() => {
                    throw new Error('GPU unavailable');
                }),
            } as never,
            argv: ['electron'],
            availableParallelism: vi.fn(() => {
                throw new Error('CPU count unavailable');
            }),
            cpus: vi.fn(() => Array.from({length: 4})),
            totalmem: vi.fn(() => 24 * GIB),
            performanceMode: 'low',
        });

        expect(snapshot).toEqual({
            logicalCpus: 4,
            totalRamBytes: 24 * GIB,
            safeMode: false,
            detectedTier: 'medium',
            performanceMode: 'low',
            tier: 'low',
        });
        expect(snapshot).not.toHaveProperty('gpuStatus');
    });

    it('rejects access before initialization and a second initialization', async () => {
        const {getHostResourceProfileSnapshot, initializeHostResourceProfile} = await import('@electron/resources/hostResourceProfile');
        const options = {
            app: {getGPUFeatureStatus: vi.fn(() => ({}))} as never,
            argv: ['electron'],
            availableParallelism: vi.fn(() => 4),
            totalmem: vi.fn(() => 12 * GIB),
            performanceMode: 'auto' as const,
        };

        expect(() => getHostResourceProfileSnapshot()).toThrow('Host resource profile was not initialized');
        initializeHostResourceProfile(options);
        expect(() => initializeHostResourceProfile(options)).toThrow('Host resource profile is already initialized');
    });
});
