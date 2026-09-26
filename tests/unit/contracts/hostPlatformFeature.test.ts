import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodeHostEnvironmentSnapshot,
    HOST_PLATFORM_FEATURE,
} from '@contracts/hostPlatformFeature';

describe('host platform feature schemas', () => {
    const channels = HOST_PLATFORM_FEATURE.invokeChannels;
    const codecs = HOST_PLATFORM_FEATURE.ipcCodecs;

    it('preserves sync, async, and event kinds without inventing sync IPC', () => {
        expect(channels).toEqual({
            getEnvironment: 'host:getEnvironment',
            getZenModeState: 'host:getZenModeState',
            setZenMode: 'host:setZenMode',
            writeBugReportBundle: 'host:writeBugReportBundle',
        });
        expect(HOST_PLATFORM_FEATURE.eventChannels).toEqual({
            onEnvironmentChange: 'host:environmentChanged',
            onZenModeChange: 'host:zenModeChanged',
            onWheelScrollSequenceChange: 'host:wheelScrollSequenceChanged',
        });
        expect(HOST_PLATFORM_FEATURE.platformDescriptors.methods).toEqual([
            expect.objectContaining({
                path: [
                    'host',
                    'getResourceProfile',
                ],
                kind: 'sync',
                browserLazy: 'direct',
            }),
            expect.objectContaining({kind: 'async'}),
            expect.objectContaining({kind: 'async'}),
            expect.objectContaining({kind: 'async'}),
            expect.objectContaining({kind: 'async'}),
            expect.objectContaining({kind: 'event'}),
            expect.objectContaining({kind: 'event'}),
            expect.objectContaining({kind: 'event'}),
        ]);
        expect(HOST_PLATFORM_FEATURE.ipcCodecs).not.toHaveProperty('host:getResourceProfile');
    });

    it('round-trips host invoke and event payloads', () => {
        const environment = {
            platform: 'darwin',
            osScaleFactor: 2,
        } as const;
        const zenMode = {
            active: true,
            supported: true,
        };
        expect(codecs[channels.getEnvironment]!.decodeResult(environment)).toEqual(environment);
        expect(codecs[channels.getZenModeState]!.decodeResult(zenMode)).toEqual(zenMode);
        expect(codecs[channels.setZenMode]!.decodeArgs([true])).toEqual([true]);
        expect(decodeHostEnvironmentSnapshot(environment)).toEqual(environment);
        expect(codecs[channels.getZenModeState]!.decodeResult(zenMode)).toEqual(zenMode);
        expect(HOST_PLATFORM_FEATURE.events.onWheelScrollSequenceChange.payload).toBeDefined();
    });

    it('rejects malformed host arguments, results, and events', () => {
        expect(() => codecs[channels.setZenMode]!.decodeArgs(['true']))
            .toThrow('expected a boolean IPC result');
        expect(() => codecs[channels.getEnvironment]!.decodeResult({
            platform: 'freebsd',
            osScaleFactor: 1,
        })).toThrow('invalid host environment');
        expect(() => codecs[channels.getZenModeState]!.decodeResult({
            active: false,
            supported: 'yes',
        })).toThrow('invalid host zen mode state');
        expect(decodeHostEnvironmentSnapshot({
            platform: 'linux',
            osScaleFactor: 0,
        })).toBeNull();
    });
});
