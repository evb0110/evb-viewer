import type {IAppUpdateStatus, TAppUpdateCheckOrigin, TAppUpdatePhase, TAppUpdateReason} from '@contracts/updatesPlatformFeature';
import type {IHostEnvironmentSnapshot, THostPlatform} from '@contracts/hostPlatformFeature';
import {isOneOf, isRecord} from '@contracts/runtimeGuards';

export const UPDATES_STATUS_EVENT_CHANNEL = 'updates:status';
export const HOST_ENVIRONMENT_ARGUMENT_PREFIX = '--evb-host-environment=';

const APP_UPDATE_VERSION_MAX_LENGTH = 128;
const APP_UPDATE_MESSAGE_MAX_LENGTH = 4_096;
const HOST_OS_SCALE_FACTOR_MAX = 8;

const APP_UPDATE_PHASES = [
    'idle',
    'checking',
    'available',
    'downloading',
    'downloaded',
    'no-update',
    'error',
    'unsupported',
] as const satisfies readonly TAppUpdatePhase[];

const APP_UPDATE_ORIGINS = ['auto', 'manual'] as const satisfies readonly TAppUpdateCheckOrigin[];

const APP_UPDATE_REASONS = [
    'check-failed',
    'check-timed-out',
    'network-unavailable',
    'feed-unavailable',
    'download-failed',
    'install-failed',
    'install-permission-denied',
    'install-preparation-failed',
    'store-updates',
    'signed-build-required',
    'runtime-unsupported',
] as const satisfies readonly TAppUpdateReason[];

const HOST_PLATFORMS = ['darwin', 'win32', 'linux'] as const satisfies readonly THostPlatform[];

/**
 * Lightweight preload decoder for `updates:status` frames (used by automation
 * ingress), matching `decodeAppUpdateStatus` in `@contracts/updatesPlatformFeature`
 * without pulling Valibot schemas into `preload.cjs`.
 */
export function decodePreloadAppUpdateStatus(value: unknown): IAppUpdateStatus | null {
    if (!isRecord(value)) {
        return null;
    }
    const {reason, phase, origin, version, percent, message, requestedHere} = value;
    if (!isOneOf(APP_UPDATE_PHASES, phase) || !isOneOf(APP_UPDATE_ORIGINS, origin)) {
        return null;
    }
    if (reason !== undefined && !isOneOf(APP_UPDATE_REASONS, reason)) {
        return null;
    }
    if (version !== null && (typeof version !== 'string' || version.length > APP_UPDATE_VERSION_MAX_LENGTH)) {
        return null;
    }
    if (percent !== null && (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100)) {
        return null;
    }
    if (message !== null && (typeof message !== 'string' || message.length > APP_UPDATE_MESSAGE_MAX_LENGTH)) {
        return null;
    }
    if (requestedHere !== undefined && typeof requestedHere !== 'boolean') {
        return null;
    }

    return {
        ...(reason === undefined ? {} : {reason}),
        phase,
        origin,
        version,
        percent,
        message,
        ...(requestedHere === undefined ? {} : {requestedHere}),
    };
}

/**
 * Lightweight preload decoder for the `--evb-host-environment=` startup
 * argument, matching `decodeHostEnvironmentSnapshot` in
 * `@contracts/hostPlatformFeature` without pulling Valibot schemas into
 * `preload.cjs`.
 */
export function decodePreloadHostEnvironmentSnapshot(value: unknown): IHostEnvironmentSnapshot | null {
    if (!isRecord(value)) {
        return null;
    }
    const {platform, osScaleFactor} = value;
    if (
        !isOneOf(HOST_PLATFORMS, platform) ||
        typeof osScaleFactor !== 'number' ||
        !Number.isFinite(osScaleFactor) ||
        osScaleFactor <= 0 ||
        osScaleFactor > HOST_OS_SCALE_FACTOR_MAX
    ) {
        return null;
    }
    return {
        platform,
        osScaleFactor,
    };
}
