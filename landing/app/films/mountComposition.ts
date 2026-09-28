// Mounts a Remotion Player as a React island; called from Vue on the client only.
import {
    Player, type PlayerRef,
} from '@remotion/player';
import {
    createElement,
    createRef,
} from 'react';
import { createRoot } from 'react-dom/client';
import { INTRO_FRAMES } from '~/films/makeRealFilm';
import {
    loadComposition, type TCompositionId, type TFilmTheme,
} from '~/films/registry';

export interface IPlayerHandle {
    durationInFrames: number;
    /** The frame shown before playback starts: after the opening fade, or the still for reduced motion. */
    initialFrame: number;
    play: () => void;
    pause: () => void;
    toggle: () => void;
    seekTo: (frame: number) => void;
    unmount: () => void;
}

interface IMountOptions {
    reducedMotion: boolean;
    /** Called once the film has drawn real content, so the poster can go. */
    onReady?: () => void;
    onFrame?: (frame: number) => void;
    onPlayingChange?: (playing: boolean) => void;
}

export async function mountComposition(
    el: HTMLElement,
    id: TCompositionId,
    locale: string,
    theme: TFilmTheme,
    options: IMountOptions,
): Promise<IPlayerHandle> {
    const comp = await loadComposition(id, locale, theme);
    const initialFrame = options.reducedMotion ? comp.stillFrame : INTRO_FRAMES;
    const ref = createRef<PlayerRef>();
    const root = createRoot(el);
    root.render(
        createElement(Player, {
            ref,
            component: comp.component,
            inputProps: { onReady: options.onReady },
            durationInFrames: comp.durationInFrames,
            fps: 30,
            compositionWidth: comp.width,
            compositionHeight: comp.height,
            // The host starts playback once the film reports ready, so the clock does not run while states load.
            autoPlay: false,
            // The poster shows the first state; start after the opening fade so the handoff is invisible.
            initialFrame,
            loop: true,
            initiallyMuted: true,
            // The films are silent; shared audio tags would load a data: sound the landing CSP blocks.
            numberOfSharedAudioTags: 0,
            controls: false,
            clickToPlay: false,
            doubleClickToFullscreen: false,
            spaceKeyToPlayOrPause: false,
            acknowledgeRemotionLicense: true,
            style: {
                width: '100%',
                height: '100%',
            },
        }),
    );
    // The ref is attached after React commits the first render.
    queueMicrotask(function attach() {
        const player = ref.current;
        if (!player) {
            setTimeout(attach, 16);
            return;
        }
        player.addEventListener('frameupdate', (e) => options.onFrame?.(e.detail.frame));
        player.addEventListener('play', () => options.onPlayingChange?.(true));
        player.addEventListener('pause', () => options.onPlayingChange?.(false));
        options.onPlayingChange?.(player.isPlaying());
    });
    return {
        durationInFrames: comp.durationInFrames,
        initialFrame,
        play: () => ref.current?.play(),
        pause: () => ref.current?.pause(),
        toggle: () => ref.current?.toggle(),
        seekTo: (frame) => ref.current?.seekTo(frame),
        unmount: () => root.unmount(),
    };
}
