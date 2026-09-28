/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Remotion entry for recorder/render.mjs: one composition, built from the manifest passed as input props.
import { useMemo } from 'react';
import {
    Composition,
    registerRoot,
} from 'remotion';
import {
    type IFilmManifest,
    makeRealFilm,
} from './makeRealFilm';

interface IFilmProps extends Record<string, unknown> {manifest: IFilmManifest;}

const PLACEHOLDER: IFilmManifest = {
    film: '',
    title: '',
    width: 1280,
    height: 800,
    fonts: [],
    steps: [],
};

function RecordedFilm({ manifest }: IFilmProps) {
    const { Film } = useMemo(() => makeRealFilm(manifest), [manifest]);
    return <Film />;
}

function FilmRoot() {
    return (
        <Composition
            id="film"
            component={RecordedFilm}
            defaultProps={{ manifest: PLACEHOLDER }}
            fps={30}
            width={1280}
            height={800}
            durationInFrames={1}
            calculateMetadata={({ props }) => ({
                width: props.manifest.width,
                height: props.manifest.height,
                durationInFrames: props.manifest.steps.reduce((total, step) => total + step.dur, 0),
            })}
        />
    );
}

registerRoot(FilmRoot);
