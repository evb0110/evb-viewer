import {
    describe,
    expect,
    it,
} from 'vitest';
import { DEFAULT_SETTINGS } from '@contracts/settings';
import { SETTINGS_PLATFORM_FEATURE } from '@contracts/settingsPlatformFeature';

describe('settings platform feature schemas', () => {
    const channels = SETTINGS_PLATFORM_FEATURE.invokeChannels;
    const codecs = SETTINGS_PLATFORM_FEATURE.ipcCodecs;

    it('preserves settings invoke channels without an event layer', () => {
        expect(channels).toEqual({
            get: 'settings:get',
            getRecoveryNotice: 'settings:getRecoveryNotice',
            save: 'settings:save',
        });
        expect(SETTINGS_PLATFORM_FEATURE.eventChannels).toEqual({});
        expect(SETTINGS_PLATFORM_FEATURE.platformDescriptors.methods).toHaveLength(3);
    });

    it('round-trips valid patches and complete settings results', () => {
        expect(codecs[channels.save]!.decodeArgs([{theme: 'dark'}])).toEqual([{theme: 'dark'}]);
        expect(codecs[channels.save]!.decodeResult(undefined)).toBeUndefined();
        expect(codecs[channels.get]!.decodeResult(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
        expect(codecs[channels.getRecoveryNotice]!.decodeResult({reason: 'unsupported'})).toEqual({reason: 'unsupported'});
        expect(codecs[channels.getRecoveryNotice]!.decodeResult(null)).toBeNull();
    });

    it('rejects malformed and normalized-away settings fields', () => {
        expect(() => codecs[channels.save]!.decodeArgs([]))
            .toThrow('expected 1 arguments, received 0');
        expect(() => codecs[channels.save]!.decodeArgs([{theme: 'sepia'}]))
            .toThrow('invalid settings field: theme');
        expect(() => codecs[channels.save]!.decodeArgs([{unknown: true}]))
            .toThrow('invalid settings field: unknown');
        expect(() => codecs[channels.save]!.decodeArgs([{agentMcpEnabled: true}]))
            .toThrow('invalid settings field: agentMcpEnabled');
        expect(() => codecs[channels.save]!.decodeArgs([{skippedUpdateVersion: '1.2.3'}]))
            .toThrow('invalid settings field: skippedUpdateVersion');
        expect(() => codecs[channels.save]!.decodeArgs([{version: Number.POSITIVE_INFINITY}]))
            .toThrow('invalid settings field: version');
        expect(() => codecs[channels.get]!.decodeResult({
            ...DEFAULT_SETTINGS,
            theme: 'sepia',
        })).toThrow('invalid settings result field: theme');
        expect(() => codecs[channels.get]!.decodeResult({
            ...DEFAULT_SETTINGS,
            version: Number.NaN,
        })).toThrow('invalid settings result field: version');
    });

    it('keeps fixture examples valid at both boundaries', () => {
        for (const {
            descriptor,
            example,
        } of SETTINGS_PLATFORM_FEATURE.fixtureMethods) {
            const methodName = descriptor.path.at(-1);
            const channel = channels[methodName as keyof typeof channels];
            expect(() => codecs[channel]!.decodeResult(example())).not.toThrow();
        }
    });
});
