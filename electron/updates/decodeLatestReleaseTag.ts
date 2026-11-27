import {isRecord} from '@contracts/runtimeGuards';

export function decodeLatestReleaseTag(value: unknown) {
    if (!isRecord(value) || !isRecord(value.release) || typeof value.release.tag !== 'string') {
        return null;
    }
    return value.release.tag;
}
