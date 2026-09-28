// Manifest files are separate async chunks, so each visitor downloads only the chosen variant.
import type { ComponentType } from 'react';
import type { IFilmManifest } from '~/films/makeRealFilm';

interface IComposition {
    component: ComponentType<{ onReady?: () => void }>;
    width: number;
    height: number;
    durationInFrames: number;
    /** Frame shown when the visitor prefers reduced motion. */
    stillFrame: number;
}

interface IFilmVariant {
    locale: string;
    theme: TFilmTheme;
    path: string;
    manifestKey: string;
    load: () => Promise<{ default: IFilmManifest }>;
}

export type TCompositionId = 'viewer';
export type TFilmTheme = 'light' | 'dark';

const manifestLoaders = import.meta.glob<{ default: IFilmManifest }>('./manifests/viewer.*.*.json');
const compositionCache = new Map<string, Promise<IComposition>>();

/** The recording for this locale and theme, else English in the same theme, else any English one. */
export function resolveFilmVariant(id: TCompositionId, locale: string, theme: TFilmTheme): IFilmVariant | null {
    const requested = [
        {
            locale,
            theme,
        },
        {
            locale: 'en',
            theme,
        },
        {
            locale: 'en',
            theme: 'dark' as const,
        },
        {
            locale: 'en',
            theme: 'light' as const,
        },
    ];
    const seen = new Set<string>();

    for (const candidate of requested) {
        const manifestKey = `./manifests/${id}.${candidate.locale}.${candidate.theme}.json`;
        if (seen.has(manifestKey)) {
            continue;
        }
        seen.add(manifestKey);
        const load = manifestLoaders[manifestKey];
        if (load) {
            return {
                locale: candidate.locale,
                theme: candidate.theme,
                path: `${id}/${candidate.locale}-${candidate.theme}`,
                manifestKey,
                load,
            };
        }
    }

    return null;
}

export function loadComposition(id: TCompositionId, locale: string, theme: TFilmTheme): Promise<IComposition> {
    const variant = resolveFilmVariant(id, locale, theme);
    if (!variant) {
        return Promise.reject(new Error(`No film recording is available for ${id} (${locale}, ${theme})`));
    }
    let composition = compositionCache.get(variant.manifestKey);
    if (!composition) {
        composition = variant.load().then(async ({ default: manifest }) => {
            const { makeRealFilm } = await import('~/films/makeRealFilm');
            const {
                Film,
                total,
            } = makeRealFilm(manifest);
            return {
                component: Film,
                width: manifest.width,
                height: manifest.height,
                durationInFrames: total,
                stillFrame: Math.round(total * 0.3),
            };
        });
        compositionCache.set(variant.manifestKey, composition);
    }
    return composition;
}
