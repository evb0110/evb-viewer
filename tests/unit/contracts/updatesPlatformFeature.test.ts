import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodeAppUpdateStatus,
    UPDATES_PLATFORM_FEATURE,
} from '@contracts/updatesPlatformFeature';

describe('updates platform feature schemas', () => {
    const channels = UPDATES_PLATFORM_FEATURE.invokeChannels;
    const codecs = UPDATES_PLATFORM_FEATURE.ipcCodecs;
    const validStatus = {
        phase: 'downloading',
        origin: 'manual',
        version: '2.0.0',
        percent: 50,
        message: null,
    } as const;

    it('owns update invokes and the decoded status event', () => {
        expect(channels).toEqual({
            getState: 'updates:getState',
            check: 'updates:check',
            download: 'updates:download',
            install: 'updates:install',
            defer: 'updates:defer',
            skipVersion: 'updates:skipVersion',
        });
        expect(UPDATES_PLATFORM_FEATURE.eventChannels).toEqual({onStatus: 'updates:status'});
        expect(UPDATES_PLATFORM_FEATURE.platformDescriptors.methods).toHaveLength(7);
        expect(UPDATES_PLATFORM_FEATURE.platformDescriptors.methods.every(
            descriptor => descriptor.required.browser === false && descriptor.required.electron,
        )).toBe(true);
    });

    it('round-trips valid update requests and results', () => {
        expect(codecs[channels.getState]!.decodeResult(validStatus)).toEqual(validStatus);
        expect(codecs[channels.check]!.decodeResult({started: true})).toEqual({started: true});
        expect(codecs[channels.download]!.decodeResult({started: false})).toEqual({started: false});
        expect(codecs[channels.defer]!.decodeResult(undefined)).toBeUndefined();
        expect(codecs[channels.skipVersion]!.decodeArgs(['2.0.0'])).toEqual(['2.0.0']);
        expect(decodeAppUpdateStatus(validStatus)).toEqual(validStatus);
    });

    it('rejects malformed update arguments, results, and events', () => {
        expect(() => codecs[channels.skipVersion]!.decodeArgs([2])).toThrow('expected a string');
        expect(() => codecs[channels.check]!.decodeResult({started: 'yes'}))
            .toThrow('expected a started result');
        expect(() => codecs[channels.getState]!.decodeResult({
            ...validStatus,
            percent: 101,
        }))
            .toThrow('invalid app update status');
        expect(decodeAppUpdateStatus({
            ...validStatus,
            phase: 'future',
        })).toBeNull();
    });
});
