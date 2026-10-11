import {
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';

/** Exact native argv and launch directory carried by Electron's single-instance lock. */
export interface ISecondInstanceLaunch {
    argv: string[];
    workingDirectory: string;
}

export function isSecondInstanceLaunch(value: unknown): value is ISecondInstanceLaunch {
    return isRecord(value)
        && isStringArray(value.argv)
        && typeof value.workingDirectory === 'string';
}
