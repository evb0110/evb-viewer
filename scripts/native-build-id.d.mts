export function getNativeExternalBuildInputs(crateName: string): string[];
export function computeNativeBuildId(projectRoot: string, crateName: string): string;
export function computeNativeBuildIds(projectRoot: string): Record<string, string>;
