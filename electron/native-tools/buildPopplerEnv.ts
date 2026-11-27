import {join} from 'path';

export interface IPopplerRuntimePaths {
    popplerDataDir?: string;
    popplerFontConfigDir?: string;
}

export function buildPopplerEnv(paths: IPopplerRuntimePaths): NodeJS.ProcessEnv | undefined {
    const env: NodeJS.ProcessEnv = {};

    if (paths.popplerDataDir) {
        env.POPPLER_DATADIR = paths.popplerDataDir;
    }

    if (paths.popplerFontConfigDir) {
        env.FONTCONFIG_PATH = paths.popplerFontConfigDir;
        env.FONTCONFIG_FILE = join(paths.popplerFontConfigDir, 'fonts.conf');
    }

    if (Object.keys(env).length === 0) {
        return undefined;
    }

    return env;
}
