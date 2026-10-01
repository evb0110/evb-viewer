import {
    UI_SCALE_PREFERENCE_ARGUMENT_PREFIX,
    decodeUiScalePreference,
} from '@contracts/settings';
import { readStartupArgumentJson } from '@electron/preload/readStartupArgumentJson';

export function readUiScalePreferenceArgument(
    argv: readonly string[] = process.argv,
) {
    return decodeUiScalePreference(
        readStartupArgumentJson(UI_SCALE_PREFERENCE_ARGUMENT_PREFIX, argv),
    );
}
