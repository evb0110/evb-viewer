import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface INativeRustTarget {
    arch: string;
    binaryExtension: string;
    cargoTargetArgs: string[];
    isHostTarget: boolean;
    platform: string;
    platformArch: string;
    rustTarget: string;
}

interface INativeRustTargetsModule {
    getHostNativeTarget: (target?: {
        arch?: string;
        platform?: string;
    }) => {
        arch: string;
        platform: string;
    };
    getRequestedNativeRustTarget: (
        env?: Record<string, string | undefined>,
        hostTarget?: {
            arch: string;
            platform: string;
        },
    ) => INativeRustTarget;
    normalizeNativeTargetArch: (value: string) => string;
    normalizeNativeTargetPlatform: (value: string) => string;
}

const {
    getHostNativeTarget,
    getRequestedNativeRustTarget,
    normalizeNativeTargetArch,
    normalizeNativeTargetPlatform,
} = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/native-rust-targets.mjs')).href
) as INativeRustTargetsModule;

describe('native Rust targets', () => {
    it('normalizes release workflow platform and architecture aliases', () => {
        expect(normalizeNativeTargetPlatform('mac')).toBe('darwin');
        expect(normalizeNativeTargetPlatform('win')).toBe('win32');
        expect(normalizeNativeTargetArch('x86_64')).toBe('x64');
        expect(normalizeNativeTargetArch('aarch64')).toBe('arm64');
    });

    it('names the host target too, so an ambient Cargo default target cannot redirect the build', () => {
        expect(getRequestedNativeRustTarget({}, {
            arch: 'arm64',
            platform: 'darwin',
        })).toEqual({
            arch: 'arm64',
            binaryExtension: '',
            cargoTargetArgs: [
                '--target',
                'aarch64-apple-darwin',
            ],
            isHostTarget: true,
            platform: 'darwin',
            platformArch: 'darwin-arm64',
            rustTarget: 'aarch64-apple-darwin',
        });
    });

    it('resolves Windows arm64 as a cargo cross target on Windows x64 release runners', () => {
        expect(getRequestedNativeRustTarget({
            EVB_NATIVE_TARGET_ARCH: 'arm64',
            EVB_NATIVE_TARGET_PLATFORM: 'win',
        }, {
            arch: 'x64',
            platform: 'win32',
        })).toEqual({
            arch: 'arm64',
            binaryExtension: '.exe',
            cargoTargetArgs: [
                '--target',
                'aarch64-pc-windows-msvc',
            ],
            isHostTarget: false,
            platform: 'win32',
            platformArch: 'win32-arm64',
            rustTarget: 'aarch64-pc-windows-msvc',
        });
    });

    it('rejects unsupported host architectures before staging release binaries', () => {
        expect(() => getHostNativeTarget({
            arch: 'ia32',
            platform: 'linux',
        })).toThrow('Unsupported native Rust target architecture');
    });

    it('rejects unsupported host platforms before staging release binaries', () => {
        expect(() => getHostNativeTarget({
            arch: 'x64',
            platform: 'freebsd',
        })).toThrow('Unsupported native Rust target platform');
    });
});
