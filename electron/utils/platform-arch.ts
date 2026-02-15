interface IResolvePlatformArchOptions {
    platform?: NodeJS.Platform;
    arch?: string;
    allowedPlatforms?: readonly string[];
    allowedArchs?: readonly string[];
}

interface IResolvedPlatformArch {
    platform: string;
    arch: string;
    tag: string;
}

const PLATFORM_MAP: Record<string, string> = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'win32',
};

const ARCH_MAP: Record<string, string> = {
    arm64: 'arm64',
    ia32: 'ia32',
    x64: 'x64',
};

function formatAllowedValues(values: readonly string[] | undefined): string {
    if (!values || values.length === 0) {
        return '';
    }
    return ` (allowed: ${values.join(', ')})`;
}

export function resolvePlatformArch(
    options: IResolvePlatformArchOptions = {},
): IResolvedPlatformArch {
    const sourcePlatform = options.platform ?? process.platform;
    const sourceArch = options.arch ?? process.arch;

    const mappedPlatform = PLATFORM_MAP[sourcePlatform];
    if (!mappedPlatform) {
        throw new Error(`Unsupported platform: ${sourcePlatform}`);
    }

    const mappedArch = ARCH_MAP[sourceArch];
    if (!mappedArch) {
        throw new Error(`Unsupported architecture: ${sourceArch}`);
    }

    if (
        options.allowedPlatforms &&
        !options.allowedPlatforms.includes(mappedPlatform)
    ) {
        throw new Error(
            `Platform "${mappedPlatform}" is not supported in this context${formatAllowedValues(options.allowedPlatforms)}`,
        );
    }

    if (options.allowedArchs && !options.allowedArchs.includes(mappedArch)) {
        throw new Error(
            `Architecture "${mappedArch}" is not supported in this context${formatAllowedValues(options.allowedArchs)}`,
        );
    }

    return {
        platform: mappedPlatform,
        arch: mappedArch,
        tag: `${mappedPlatform}-${mappedArch}`,
    };
}

export function resolvePlatformArchTag(
    options: IResolvePlatformArchOptions = {},
): string {
    return resolvePlatformArch(options).tag;
}
