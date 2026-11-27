import type {IRunCommandOptions} from '@electron/native-tools/runNativeCommand';

export function withDefinedCommandOptions(base: IRunCommandOptions, overrides: Partial<IRunCommandOptions>): IRunCommandOptions {
    const merged: IRunCommandOptions = {...base};
    const entries: Array<[string, unknown]> = Object.entries(overrides);
    for (const [key, value] of entries) {
        if (value !== undefined) {
            Object.assign(merged, {[key]: value});
        }
    }
    return merged;
}
