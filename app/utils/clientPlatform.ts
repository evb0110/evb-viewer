interface IClientNavigatorLike {
    platform?: string;
    userAgent?: string;
    userAgentData?: {platform?: string};
}

export function isMacPlatformHint(value: string) {
    return /mac|macintosh|mac os|macos|darwin/iu.test(value);
}

export function isMacClientPlatform(
    clientNavigator: IClientNavigatorLike | undefined = typeof navigator === 'undefined' ? undefined : navigator,
) {
    if (!clientNavigator) {
        return false;
    }

    return [clientNavigator.userAgentData?.platform, clientNavigator.platform, clientNavigator.userAgent].some(
        (value) => typeof value === 'string' && isMacPlatformHint(value),
    );
}
