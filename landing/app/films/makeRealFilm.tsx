/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Plays a recorded flow of the real app: SVG snapshots of the live DOM (dom-to-svg), sequenced
// with a pointer, click ripples and a camera. Adapted from the EVB Player landing films.
// Recorder: landing/recorder; manifests: ./manifests/*.json; SVGs and fonts: /films/<film>/.
import {
    useEffect,
    useState,
} from 'react';
import {
    Easing,
    interpolate,
    useCurrentFrame,
} from 'remotion';

type TRect = [number, number, number, number];

export interface IFilmStep {
    svg: string;
    dur: number;
    /** cut: instant; fade: crossfade from the previous state; dip: previous fades to the app background, this fades in. */
    transition?: 'cut' | 'fade' | 'dip';
    fade: number;
    cursor: [number, number] | null;
    click: boolean;
    focus: TRect | null;
    pan: [TRect, TRect] | null;
    height: number;
    caret: [number, number, number] | null;
}

export interface IFilmManifest {
    film: string;
    title: string;
    width: number;
    height: number;
    background?: string;
    fonts: Array<{
        family: string;
        url: string;
        weight: string;
        style: string;
        unicodeRange?: string;
    }>;
    steps: IFilmStep[];
}

const LOOP_OUT = 12;
const LOOP_IN = 10;
/** Frames of the opening fade; a player taking over from the poster starts here. */
export const INTRO_FRAMES = LOOP_IN;
const CURSOR_MOVE = 16;
const CAMERA_MOVE = 20;
const cache = new Map<string, Promise<string>>();
const loadedFonts = new Set<string>();

function fetchSvg(url: string) {
    if (!cache.has(url)) {
        cache.set(
            url,
            fetch(url).then((r) => r.text()),
        );
    }
    return cache.get(url)!;
}

/**
 * Loads the film's SVG states and fonts. Resolves as soon as the first state is available
 * (so the player can take over from the server-rendered poster early); later states stream in.
 */
function useFilmAssets(m: IFilmManifest) {
    const [
        svgs,
        setSvgs,
    ] = useState<Record<string, string> | null>(null);
    useEffect(() => {
        let alive = true;
        const base = `/films/${m.film}/`;
        // Fonts are shared by every variant of a film; resolve '../fonts/…' so each file loads once.
        const fontUrl = (url: string) => new URL(url, new URL(base, location.href)).pathname;
        const fonts = m.fonts
            .filter((f) => !loadedFonts.has(fontUrl(f.url)))
            .map((f) =>
                new FontFace(f.family, `url(${fontUrl(f.url)})`, {
                    weight: f.weight,
                    style: f.style,
                    ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
                })
                    .load()
                    .then((face) => {
                        document.fonts.add(face);
                        loadedFonts.add(fontUrl(f.url));
                    })
                    .catch(() => {}),
            );
        const files = [...new Set(m.steps.map((s) => s.svg))];
        const loaded: Record<string, string> = {};
        let firstShown = false;
        const first = m.steps[0]!.svg;
        Promise.all([
            fetchSvg(base + first),
            ...fonts,
        ]).then(([text]) => {
            loaded[first] = text;
            firstShown = true;
            if (alive) setSvgs({ ...loaded });
        });
        for (const file of files) {
            fetchSvg(base + file).then((text) => {
                loaded[file] = text;
                if (alive && firstShown) setSvgs({ ...loaded });
            });
        }
        return () => {
            alive = false;
        };
    }, [m]);
    return svgs;
}

function lerpRect(a: TRect, b: TRect, t: number): TRect {
    return [
        0,
        1,
        2,
        3,
    ].map((i) => a[i]! + (b[i]! - a[i]!) * t) as TRect;
}

function Pointer({
    x,
    y,
    pressed,
}: {
    x: number;
    y: number;
    pressed: number
}) {
    return (
        <svg
            width={28}
            height={28}
            viewBox="0 0 28 28"
            style={{
                position: 'absolute',
                left: x - 3,
                top: y - 2,
                overflow: 'visible',
                transform: `scale(${1 - pressed * 0.12})`,
                transformOrigin: '3px 2px',
            }}
        >
            <path
                d="M3 2 L3 22 L8.5 17 L12.5 26 L16 24.5 L12 15.8 L19.5 15.5 Z"
                fill="#111"
                stroke="#fff"
                strokeWidth={1.6}
                strokeLinejoin="round"
            />
        </svg>
    );
}

export function makeRealFilm(m: IFilmManifest) {
    const starts: number[] = [];
    let acc = 0;
    for (const s of m.steps) {
        starts.push(acc);
        acc += s.dur;
    }
    const total = acc;
    const full: TRect = [
        0,
        0,
        m.width,
        m.height,
    ];

    // Resolved pointer target and camera per step (inherit from previous when unset).
    const cursorAt: Array<[number, number] | null> = [];
    const cameraAt: TRect[] = [];
    m.steps.forEach((s, i) => {
        cursorAt.push(s.cursor ?? cursorAt[i - 1] ?? null);
        cameraAt.push(s.pan ? s.pan[0] : (s.focus ?? full));
    });
    const cameraEnd = m.steps.map((s, i) => (s.pan ? s.pan[1] : cameraAt[i]!));

    function Film({ onReady }: { onReady?: () => void }) {
        const frame = useCurrentFrame();
        const svgs = useFilmAssets(m);
        const ready = svgs !== null;
        useEffect(() => {
            if (ready) onReady?.();
        }, [
            ready,
            onReady,
        ]);
        /** A state still loading shows the nearest earlier loaded state instead of a blank layer. */
        const markupFor = (s: IFilmStep) => {
            for (let k = m.steps.indexOf(s); k >= 0; k--) {
                const text = svgs?.[m.steps[k]!.svg];
                if (text) {
                    return text;
                }
            }
            return '';
        };
        let i = starts.findIndex(
            (st, k) => frame >= st && frame < st + m.steps[k]!.dur,
        );
        if (i < 0) i = m.steps.length - 1;
        const step = m.steps[i]!;
        const local = frame - starts[i]!;
        const prev = i > 0 ? m.steps[i - 1]! : null;
        const kind = step.transition ?? (step.fade > 0 ? 'fade' : 'cut');
        const span = Math.max(1, step.fade);
        let prevOpacity = 0;
        let curOpacity = 1;
        if (prev && kind === 'fade' && local < span) {
            prevOpacity = 1;
            curOpacity = local / span;
        } else if (prev && kind === 'dip' && local < span) {
            const half = span / 2;
            prevOpacity = local < half ? 1 - local / half : 0;
            curOpacity = local < half ? 0 : (local - half) / half;
        }
        // Loop seam: dip the last state to the background, and bring the first state in from it.
        const loopOut = interpolate(frame, [
            total - LOOP_OUT,
            total,
        ], [
            1,
            0,
        ], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
        });
        const loopIn = interpolate(frame, [
            0,
            LOOP_IN,
        ], [
            0,
            1,
        ], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
        });
        curOpacity *= loopOut * (i === 0 ? loopIn : 1);
        const bg = m.background ?? '#ffffff';

        // Camera: move from the previous step's end framing to this step's framing, then pan if asked.
        const fromCam = i > 0 ? cameraEnd[i - 1]! : cameraAt[0]!;
        // Different capture heights (scrolled full-page vs viewport) mean different coordinate spaces: cut the camera.
        const sameSpace = !prev || prev.height === step.height;
        const settle = sameSpace
            ? interpolate(local, [
                0,
                CAMERA_MOVE,
            ], [
                0,
                1,
            ], {
                extrapolateRight: 'clamp',
                easing: Easing.inOut(Easing.cubic),
            })
            : 1;
        let cam = lerpRect(fromCam, cameraAt[i]!, settle);
        if (step.pan) {
            const t = interpolate(
                local,
                [
                    CAMERA_MOVE * 0.5,
                    step.dur - 6,
                ],
                [
                    0,
                    1,
                ],
                {
                    extrapolateLeft: 'clamp',
                    extrapolateRight: 'clamp',
                    easing: Easing.inOut(Easing.sin),
                },
            );
            cam = lerpRect(cam, step.pan[1], t);
        }
        const scale = Math.min(m.width / cam[2], m.height / cam[3]);
        const tx = -cam[0] * scale + (m.width - cam[2] * scale) / 2;
        const ty = -cam[1] * scale + (m.height - cam[3] * scale) / 2;

        // Pointer: glide to this step's target at the start of the step.
        const target = cursorAt[i];
        const from = i > 0 ? cursorAt[i - 1] : null;
        let pointer: [number, number] | null = null;
        if (target) {
            const t = interpolate(local, [
                0,
                CURSOR_MOVE,
            ], [
                0,
                1,
            ], {
                extrapolateRight: 'clamp',
                easing: Easing.inOut(Easing.cubic),
            });
            pointer = from
                ? [
                    from[0] + (target[0] - from[0]) * t,
                    from[1] + (target[1] - from[1]) * t,
                ]
                : target;
        }
        const clickT = step.click
            ? interpolate(local, [
                step.dur - 8,
                step.dur,
            ], [
                0,
                1,
            ], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
            })
            : 0;
        const pressed = step.click
            ? Math.sin(Math.min(1, clickT) * Math.PI)
            : 0;
        const ripple =
            i > 0 && m.steps[i - 1]!.click
                ? interpolate(local, [
                    0,
                    14,
                ], [
                    0,
                    1,
                ], {extrapolateRight: 'clamp'})
                : 0;
        const rippleAt = i > 0 ? cursorAt[i - 1] : null;
        const caretOn =
            step.caret && curOpacity > 0.9 && Math.floor(frame / 16) % 2 === 0;

        const layer = (s: IFilmStep, opacity: number, key: string) => (
            <div
                key={key}
                style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: m.width,
                    height: s.height,
                    opacity,
                }}
                dangerouslySetInnerHTML={{ __html: markupFor(s) }}
            />
        );

        return (
            <div
                style={{
                    position: 'absolute',
                    inset: 0,
                    overflow: 'hidden',
                    background: bg,
                }}
            >
                {svgs && (
                    <div
                        style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            width: m.width,
                            height: m.height,
                            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                            transformOrigin: '0 0',
                        }}
                    >
                        {prev &&
                            prevOpacity > 0 &&
                            layer(prev, prevOpacity, `p${i}`)}
                        {curOpacity > 0 && layer(step, curOpacity, `s${i}`)}
                        {caretOn && step.caret && (
                            <div
                                style={{
                                    position: 'absolute',
                                    left: step.caret[0],
                                    top: step.caret[1],
                                    width: 1.5,
                                    height: step.caret[2],
                                    background: '#111',
                                }}
                            />
                        )}
                        {ripple > 0 && ripple < 1 && rippleAt && (
                            <div
                                style={{
                                    position: 'absolute',
                                    left: rippleAt[0] - 18,
                                    top: rippleAt[1] - 18,
                                    width: 36,
                                    height: 36,
                                    borderRadius: '50%',
                                    border: '2px solid rgba(14, 116, 184, 0.9)',
                                    transform: `scale(${0.4 + ripple})`,
                                    opacity: 1 - ripple,
                                }}
                            />
                        )}
                        {pointer &&
                            loopOut > 0.5 &&
                            (i > 0 || loopIn > 0.5) && (
                            <Pointer
                                x={pointer[0]}
                                y={pointer[1]}
                                pressed={pressed}
                            />
                        )}
                    </div>
                )}
            </div>
        );
    }

    return {
        Film,
        total,
    };
}
