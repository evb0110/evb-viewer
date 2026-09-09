/* eslint-disable custom/file-naming -- This module is the dedicated build-time define boundary. */

declare const __EVB_BUILD_GIT_SHA__: string | null | undefined;

export const embeddedScanCleanupBuildGitSha = typeof __EVB_BUILD_GIT_SHA__ === 'undefined'
    ? null
    : __EVB_BUILD_GIT_SHA__;
