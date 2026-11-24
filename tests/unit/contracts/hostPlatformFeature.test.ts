import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodeHostEnvironmentSnapshot,
    HOST_PLATFORM_FEATURE,
} from '@contracts/hostPlatformFeature';
import {
    HOST_RASTER_POOL_MAX_BYTES,
    HOST_RASTER_POOL_MIN_BYTES,
    HOST_WINDOW_RASTER_SHARE_MIN_BYTES,
    resolveHostWindowRasterShare,
} from '@contracts/hostResourceProfile';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

describe('host platform feature schemas', () => {
    const channels = HOST_PLATFORM_FEATURE.invokeChannels;
    const codecs = HOST_PLATFORM_FEATURE.ipcCodecs;

    it('preserves sync, async, and event kinds without inventing sync IPC', () => {

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
            expect.objectContaining({kind: 'async'}),
            expect.objectContaining({kind: 'async'}),
            expect.objectContaining({kind: 'event'}),
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
        const rasterBudget = {
            maxRasterSurfaceBytes: 768 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 2,
        };
        expect(codecs[channels.getEnvironment]!.decodeResult(environment)).toEqual(environment);
        expect(codecs[channels.getRasterBudget]!.decodeResult(rasterBudget)).toEqual(rasterBudget);
        expect(codecs[channels.getRasterBudget]!.decodeResult(null)).toBeNull();
        expect(codecs[channels.getZenModeState]!.decodeResult(zenMode)).toEqual(zenMode);
        expect(codecs[channels.setZenMode]!.decodeArgs([true])).toEqual([true]);
        expect(decodeHostEnvironmentSnapshot(environment)).toEqual(environment);
        expect(codecs[channels.getZenModeState]!.decodeResult(zenMode)).toEqual(zenMode);
        const windowState = {
            fullScreen: false,
            maximized: true,
            supported: true,
        };
        expect(codecs[channels.restoreNormalWindow]!.decodeResult(windowState)).toEqual(windowState);
        expect(HOST_PLATFORM_FEATURE.events.onRasterBudgetChange.payload).toBeDefined();
        expect(HOST_PLATFORM_FEATURE.events.onWheelScrollSequenceChange.payload).toBeDefined();
    });

    it('rejects malformed host arguments, results, and events', () => {
        expect(() => codecs[channels.setZenMode]!.decodeArgs(['true']))
            .toThrow('expected a boolean IPC result');
        expect(() => codecs[channels.getEnvironment]!.decodeResult({
            platform: 'freebsd',
            osScaleFactor: 1,
        })).toThrow('invalid host environment');
        expect(() => codecs[channels.getRasterBudget]!.decodeResult({
            maxRasterSurfaceBytes: HOST_WINDOW_RASTER_SHARE_MIN_BYTES - 1,
            hostPoolBytes: 1536 * MIB,
            windowCount: 2,
        })).toThrow('invalid host raster budget');
        expect(() => codecs[channels.getRasterBudget]!.decodeResult({
            maxRasterSurfaceBytes: 768 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 0,
        })).toThrow('invalid host raster budget');
        expect(() => codecs[channels.getRasterBudget]!.decodeResult({
            maxRasterSurfaceBytes: 768 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 2,
            extra: true,
        })).toThrow('invalid host raster budget');
        expect(() => codecs[channels.getRasterBudget]!.decodeResult({
            maxRasterSurfaceBytes: 512 * MIB,
            hostPoolBytes: 256 * MIB,
            windowCount: 1,
        })).toThrow('invalid host raster budget');
        expect(() => codecs[channels.getZenModeState]!.decodeResult({
            active: false,
            supported: 'yes',
        })).toThrow('invalid host zen mode state');
        expect(() => codecs[channels.restoreNormalWindow]!.decodeResult({
            fullScreen: false,
            supported: true,
        })).toThrow('invalid host window state');
        expect(decodeHostEnvironmentSnapshot({
            platform: 'linux',
            osScaleFactor: 0,
        })).toBeNull();
    });

    it('divides the host raster pool deterministically with monotonic bounds and a usable floor', () => {
        const workstation1 = resolveHostWindowRasterShare({
            totalRamBytes: 32 * GIB,
            windowCount: 1,
        });
        const workstation2 = resolveHostWindowRasterShare({
            totalRamBytes: 32 * GIB,
            windowCount: 2,
        });
        const workstation3 = resolveHostWindowRasterShare({
            totalRamBytes: 32 * GIB,
            windowCount: 3,
        });
        expect(workstation1).toEqual({
            maxRasterSurfaceBytes: 1536 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 1,
        });
        expect(workstation2).toEqual({
            maxRasterSurfaceBytes: 768 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 2,
        });
        expect(workstation3).toEqual({
            maxRasterSurfaceBytes: 512 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 3,
        });

        // Sum stays bounded by host pool whenever windowCount * floor <= hostPoolBytes,
        // and shrinks monotonically until reaching the floor.
        for (const totalRamBytes of [
            2 * GIB,
            4 * GIB,
            8 * GIB,
            16 * GIB,
            64 * GIB,
        ]) {
            let previousShare = Number.POSITIVE_INFINITY;
            for (let windowCount = 1; windowCount <= 32; windowCount += 1) {
                const share = resolveHostWindowRasterShare({
                    totalRamBytes,
                    windowCount,
                });
                expect(Number.isInteger(share.maxRasterSurfaceBytes)).toBe(true);
                expect(Number.isInteger(share.hostPoolBytes)).toBe(true);
                expect(share.maxRasterSurfaceBytes).toBeGreaterThanOrEqual(HOST_WINDOW_RASTER_SHARE_MIN_BYTES);
                expect(share.maxRasterSurfaceBytes).toBeLessThanOrEqual(HOST_RASTER_POOL_MAX_BYTES);
                expect(share.hostPoolBytes).toBeGreaterThanOrEqual(HOST_RASTER_POOL_MIN_BYTES);
                expect(share.hostPoolBytes).toBeLessThanOrEqual(HOST_RASTER_POOL_MAX_BYTES);
                expect(share.maxRasterSurfaceBytes).toBeLessThanOrEqual(previousShare);
                if (windowCount * HOST_WINDOW_RASTER_SHARE_MIN_BYTES <= share.hostPoolBytes) {
                    expect(windowCount * share.maxRasterSurfaceBytes).toBeLessThanOrEqual(share.hostPoolBytes);
                } else {
                    expect(share.maxRasterSurfaceBytes).toBe(HOST_WINDOW_RASTER_SHARE_MIN_BYTES);
                }
                previousShare = share.maxRasterSurfaceBytes;
            }
        }

        // Degenerate inputs never produce NaN, negative, or unbounded values.
        expect(resolveHostWindowRasterShare({
            totalRamBytes: Number.NaN,
            windowCount: Number.NaN,
            fallbackPoolBytes: 768 * MIB,
        })).toEqual({
            maxRasterSurfaceBytes: 768 * MIB,
            hostPoolBytes: 768 * MIB,
            windowCount: 1,
        });
        expect(resolveHostWindowRasterShare({
            totalRamBytes: 0,
            windowCount: -5,
        })).toEqual({
            maxRasterSurfaceBytes: HOST_RASTER_POOL_MAX_BYTES,
            hostPoolBytes: HOST_RASTER_POOL_MAX_BYTES,
            windowCount: 1,
        });
        expect(resolveHostWindowRasterShare({
            totalRamBytes: Number.POSITIVE_INFINITY,
            windowCount: 99_999,
        })).toEqual({
            maxRasterSurfaceBytes: HOST_WINDOW_RASTER_SHARE_MIN_BYTES,
            hostPoolBytes: HOST_RASTER_POOL_MAX_BYTES,
            windowCount: 1_024,
        });
    });

    it('accepts a window content size only as whole pixels from 1 to 32768', () => {
        const decode = codecs[channels.restoreNormalWindow]!.decodeArgs;
        expect(decode([])).toEqual([]);
        for (const size of [
            {
                width: 1,
                height: 1,
            },
            {
                width: 640,
                height: 480,
            },
            {
                width: 32_768,
                height: 32_768,
            },
        ]) {
            expect(decode([size])).toEqual([size]);
        }
        for (const size of [
            {
                width: 640.5,
                height: 480,
            },
            {
                width: 0,
                height: 480,
            },
            {
                width: 640,
                height: 32_769,
            },
            {
                width: 640,
                height: -480,
            },
            {
                width: 640,
                height: Number.POSITIVE_INFINITY,
            },
            {
                width: 640,
                height: 480,
                x: 0,
            },
        ]) {
            expect(() => decode([size]), JSON.stringify(size)).toThrow();
        }
    });
});

