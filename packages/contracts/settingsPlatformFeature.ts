import type {
    IDebugLogEntry,
    IRendererLogEntry,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';
import {
    DEFAULT_SETTINGS,
    decodeSettingsRecoveryNotice,
    isSettingsSaveKey,
    sanitizeSettings,
    type TSettingsSavePatch,
} from '@contracts/settings';
import {
    defineForwardedPlatformMethod,
    definePlatformFeature,
    type TFeatureCapability,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {isRecord} from '@contracts/runtimeGuards';
import * as v from 'valibot';

const invalidSettingsField = (field: string) => `invalid settings field: ${field}`;
const invalidSettingsResultField = (field: string) => `invalid settings result field: ${field}`;
const settingsPatchSchema = v.pipe(
    v.unknown(),
    v.transform(input => ({
        input,
        normalized: sanitizeSettings({
            ...DEFAULT_SETTINGS,
            ...(isRecord(input) ? input : {}),
        }),
    })),
    v.rawCheck(({
        dataset, addIssue,
    }) => {
        if (!dataset.typed) {
            return;
        }
        const {
            input, normalized,
        } = dataset.value;
        if (!isRecord(input)) {
            addIssue({message: 'settings must be an object'});
            return;
        }
        for (const key of Object.keys(input)) {
            if (!isSettingsSaveKey(key)) {
                addIssue({message: invalidSettingsField(key)});
                return;
            }
            if (normalized[key] !== input[key]) {
                addIssue({message: invalidSettingsField(key)});
                return;
            }
        }
    }),
    v.transform(({input}) => input as TSettingsSavePatch),
);
const settingsResultSchema = v.pipe(
    v.unknown(),
    v.transform(input => ({
        input,
        normalized: sanitizeSettings(input),
    })),
    v.rawCheck(({
        dataset, addIssue,
    }) => {
        if (!dataset.typed) {
            return;
        }
        const {
            input, normalized,
        } = dataset.value;
        if (!isRecord(input)) {
            addIssue({message: 'invalid settings result'});
            return;
        }
        const allowedKeys = new Set(Object.keys(normalized));
        for (const key of Object.keys(input)) {
            if (!allowedKeys.has(key)) {
                addIssue({message: invalidSettingsResultField(key)});
                return;
            }
        }
        for (const [
            key,
            candidate,
        ] of Object.entries(normalized)) {
            if (input[key] !== candidate) {
                addIssue({message: invalidSettingsResultField(key)});
                return;
            }
        }
    }),
    v.transform(({normalized}) => normalized),
);
const settingsRecoveryNoticeSchema = v.nullable(v.pipe(v.unknown(), v.transform(value => {
    const notice = decodeSettingsRecoveryNotice(value);
    if (!notice) {
        throw new Error('invalid settings recovery notice');
    }
    return notice;
})));
const voidResult = v.pipe(
    v.undefined('expected an undefined IPC result'),
    v.transform((): void => undefined),
);

export type TSettingsSavePatchSchema = v.InferOutput<typeof settingsPatchSchema>;

export const SETTINGS_PLATFORM_FEATURE = definePlatformFeature({
    path: ['settings'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        get: {
            kind: 'async',
            channel: 'settings:get',
            ipc: {
                args: v.strictTuple([]),
                result: settingsResultSchema,
            },
            main: {
                method: 'get',
                context: 'none',
            },
            browser: {method: 'get'},
            lazy: 'forwarded',
        },
        getRecoveryNotice: {
            kind: 'async',
            channel: 'settings:getRecoveryNotice',
            ipc: {
                args: v.strictTuple([]),
                result: settingsRecoveryNoticeSchema,
            },
            main: {
                method: 'getRecoveryNotice',
                context: 'none',
            },
            browser: {method: 'getRecoveryNotice'},
            lazy: 'forwarded',
        },
        save: defineForwardedPlatformMethod({
            name: 'save',
            channel: 'settings:save',
            args: v.strictTuple([settingsPatchSchema]),
            result: voidResult,
            main: 'save',
        }),
    },
    events: {},
});

interface ISettingsSupportCapability {
    getDebugLogs: () => Promise<IDebugLogEntry[]>;
    onDebugLog: (callback: (entry: IDebugLogEntry) => void) => TMenuEventUnsubscribe;
    rendererLog: (entry: IRendererLogEntry) => void;
}

export type ISettingsCapability =
    TFeatureCapability<typeof SETTINGS_PLATFORM_FEATURE> & ISettingsSupportCapability;
export type ISettingsInvokeMap = TFeatureInvokeMap<typeof SETTINGS_PLATFORM_FEATURE>;
