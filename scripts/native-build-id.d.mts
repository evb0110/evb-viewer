/* eslint-disable custom/file-naming -- Declaration must share native-build-id.mjs's filename. */
export function getNativeExternalBuildInputs(crateName: string): string[];
export function computeNativeBuildId(projectRoot: string, crateName: string): string;
export function computeNativeBuildIds(projectRoot: string): Record<string, string>;
