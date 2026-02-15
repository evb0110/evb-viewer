import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolvePlatformArch,
    resolvePlatformArchTag,
} from '@electron/utils/platform-arch';

interface IPlatformArchCase {
    platform: NodeJS.Platform;
    arch: string;
    expectedTag: string;
}

const PLATFORM_ARCH_CASES: IPlatformArchCase[] = [
    {
        platform: 'darwin',
        arch: 'x64',
        expectedTag: 'darwin-x64',
    },
    {
        platform: 'darwin',
        arch: 'arm64',
        expectedTag: 'darwin-arm64',
    },
    {
        platform: 'win32',
        arch: 'x64',
        expectedTag: 'win32-x64',
    },
    {
        platform: 'win32',
        arch: 'arm64',
        expectedTag: 'win32-arm64',
    },
    {
        platform: 'linux',
        arch: 'x64',
        expectedTag: 'linux-x64',
    },
    {
        platform: 'linux',
        arch: 'arm64',
        expectedTag: 'linux-arm64',
    },
];

describe('platform/arch resolution', () => {
    it.each(PLATFORM_ARCH_CASES)(
        'resolves $platform/$arch to $expectedTag',
        ({
            platform,
            arch,
            expectedTag,
        }) => {
            expect(resolvePlatformArchTag({
                platform,
                arch,
            })).toBe(expectedTag);
        },
    );

    it('keeps ia32 mapping explicit for legacy packaging flows', () => {
        expect(resolvePlatformArchTag({
            platform: 'win32',
            arch: 'ia32',
        })).toBe('win32-ia32');
    });

    it('throws for unsupported platform values', () => {
        expect(() => resolvePlatformArch({
            platform: 'freebsd',
            arch: 'x64',
        })).toThrow(/Unsupported platform: freebsd/);
    });

    it('throws for unsupported architecture values', () => {
        expect(() => resolvePlatformArch({
            platform: 'win32',
            arch: 'riscv64',
        })).toThrow(/Unsupported architecture: riscv64/);
    });

    it('respects architecture allowlists where required', () => {
        expect(() => resolvePlatformArch({
            platform: 'win32',
            arch: 'ia32',
            allowedArchs: [
                'x64',
                'arm64',
            ],
        })).toThrow(/Architecture "ia32" is not supported in this context/);
    });
});
