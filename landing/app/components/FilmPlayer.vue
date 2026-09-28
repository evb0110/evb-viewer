<template>
  <figure
    v-if="variant"
    class="film"
  >
    <div class="film-window">
      <div
        class="film-titlebar"
        aria-hidden="true"
      >
        <span class="film-light film-light-close" />
        <span class="film-light film-light-min" />
        <span class="film-light film-light-max" />
        <span class="film-title">{{ title }}</span>
      </div>
      <div
        class="film-screen"
        :style="{ aspectRatio: `${film.width} / ${film.height}` }"
      >
        <video
          v-if="mounted"
          :key="variant"
          ref="video"
          class="film-video"
          :src="`${FILM_BASE}/${variant}.mp4`"
          :aria-label="label"
          muted
          playsinline
          loop
          preload="auto"
          disablepictureinpicture
          @loadedmetadata="onMetadata"
          @playing="showPoster = false"
          @play="playing = true"
          @pause="playing = false"
        />
        <!-- The first frame, or the reduced-motion still, until the video shows it. CSS picks the
             theme already set on the html element, so the server render matches. -->
        <div
          v-if="showPoster"
          class="film-poster"
          :style="posterStyle"
        />
      </div>
    </div>
    <figcaption class="film-controls">
      <button
        class="film-toggle"
        type="button"
        :aria-label="playing ? pauseLabel : playLabel"
        @click="toggle"
      >
        <UIcon :name="playing ? 'i-ph-pause-fill' : 'i-ph-play-fill'" />
      </button>
      <div
        class="film-track"
        role="slider"
        tabindex="0"
        :aria-label="positionLabel"
        :aria-valuemin="0"
        :aria-valuemax="Math.round(duration)"
        :aria-valuenow="Math.round(time)"
        @pointerdown="seekFromPointer"
        @keydown.left.prevent="seekTo(time - 1)"
        @keydown.right.prevent="seekTo(time + 1)"
      >
        <div
          class="film-fill"
          :style="{ width: `${(time / Math.max(duration, 0.001)) * 100}%` }"
        />
      </div>
      <span class="film-time">{{ time.toFixed(1) }}s</span>
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
import {
    useIntersectionObserver,
    usePreferredReducedMotion,
    useRafFn,
} from '@vueuse/core';
import viewerFilm from '~/films/viewer.json';

type TFilmTheme = 'light' | 'dark';

interface IFilmIndex {
    fps: number
    /** First frame after the opening fade: the poster, and where playback starts. */
    intro: number
    width: number
    height: number
    variants: Record<string, {
        frames: number
        still: number
    }>
}

const {
    locale,
    theme,
} = defineProps<{
    locale: string
    theme: TFilmTheme
    label: string
    playLabel: string
    pauseLabel: string
    positionLabel: string
    title: string
}>();

// Rendered by recorder/render.mjs: one video per locale and theme, with a poster and a still.
const FILM_BASE = '/films/viewer';
const film: IFilmIndex = viewerFilm;
const video = useTemplateRef<HTMLVideoElement>('video');
const reducedMotion = usePreferredReducedMotion();
const mounted = ref(false);
const playing = ref(false);
const showPoster = ref(true);
const visible = ref(false);
const time = ref(0);
const duration = ref(0);

/** The recording for this locale and theme, else English in the same theme, else any English one. */
function resolveVariant(variantTheme: TFilmTheme) {
    return [
        `${locale}-${variantTheme}`,
        `en-${variantTheme}`,
        'en-dark',
        'en-light',
    ].find(candidate => candidate in film.variants) ?? null;
}

const variant = computed(() => resolveVariant(theme));
const still = computed(() => reducedMotion.value === 'reduce');
const posterStyle = computed(() => {
    const posterFor = (posterTheme: TFilmTheme) => {
        const name = resolveVariant(posterTheme);
        return name ? `url(${FILM_BASE}/${name}-${still.value ? 'still' : 'poster'}.jpg)` : 'none';
    };
    return {
        '--poster-light': posterFor('light'),
        '--poster-dark': posterFor('dark'),
    };
});

function play() {
    showPoster.value = false;
    void video.value?.play().catch(() => {});
}

function onMetadata() {
    const element = video.value;
    const info = variant.value ? film.variants[variant.value] : undefined;
    if (!element || !info) {
        return;
    }
    duration.value = element.duration;
    element.currentTime = (still.value ? info.still : film.intro) / film.fps;
    time.value = element.currentTime;
    if (visible.value && !still.value) {
        play();
    }
}

function toggle() {
    if (video.value?.paused) {
        play();
    } else {
        video.value?.pause();
    }
}

function seekTo(seconds: number) {
    const element = video.value;
    if (!element || !duration.value) {
        return;
    }
    element.currentTime = Math.min(duration.value, Math.max(0, seconds));
    time.value = element.currentTime;
    showPoster.value = false;
}

function seekFromPointer(event: PointerEvent) {
    if (!(event.currentTarget instanceof HTMLElement)) {
        return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const seek = (clientX: number) => seekTo(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration.value);
    seek(event.clientX);
    const move = (moveEvent: PointerEvent) => seek(moveEvent.clientX);
    const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
}

// timeupdate fires only a few times a second; follow the playhead every frame instead.
useRafFn(() => {
    if (video.value && playing.value) {
        time.value = video.value.currentTime;
    }
});

// Another locale or theme loads another recording; its poster shows until it plays.
watch(variant, () => {
    playing.value = false;
    showPoster.value = true;
    time.value = 0;
});

// Plays only while on screen.
useIntersectionObserver(video, ([entry]) => {
    visible.value = Boolean(entry?.isIntersecting);
    const element = video.value;
    if (!element || still.value || element.readyState < 1) {
        return;
    }
    if (visible.value) {
        play();
    } else {
        element.pause();
    }
});

onMounted(() => {
    // The color mode and the reduced-motion preference are known only in the browser.
    mounted.value = true;
});
</script>

<style scoped>
.film {
  margin: 0;
}

/* The window frame follows the recording's theme, keyed on the color-mode class like the poster. */
.film-window {
  overflow: hidden;
  border: 1px solid var(--landing-border-strong);
  border-radius: 0.75rem;
  background: #fff;
  box-shadow:
    0 1px 2px rgb(28 26 22 / 8%),
    0 24px 60px -18px rgb(28 26 22 / 38%);
}

.film-titlebar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 2.1rem;
  padding: 0 0.875rem;
  border-bottom: 1px solid rgb(24 24 27 / 10%);
  background: #eceef0;
}

.film-light {
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 50%;
}

.film-light-close {
  background: #ff5f57;
}

.film-light-min {
  background: #febc2e;
}

.film-light-max {
  background: #28c840;
}

.film-title {
  position: absolute;
  left: 50%;
  color: #52525b;
  font-size: 0.75rem;
  font-weight: 600;
  transform: translateX(-50%);
}

.film-screen {
  position: relative;
  width: 100%;
  background: #fff;
}

:global(html.dark .film-window),
:global(html.dark .film-screen) {
  background: #18181b;
}

:global(html.dark .film-titlebar) {
  border-bottom-color: rgb(255 255 255 / 6%);
  background: #232326;
}

:global(html.dark .film-title) {
  color: #a1a1aa;
}

.film-video,
.film-poster {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}

.film-poster {
  background: var(--poster-light) center / cover no-repeat;
}

:global(html.dark .film-poster) {
  background-image: var(--poster-dark);
}

.film-controls {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  margin-top: 0.875rem;
  padding: 0 0.25rem;
}

.film-toggle {
  display: grid;
  flex: none;
  place-items: center;
  width: 1.875rem;
  height: 1.875rem;
  border-radius: 0.5rem;
  color: var(--landing-ink);
  cursor: pointer;
}

.film-toggle:hover,
.film-toggle:focus-visible {
  background: var(--landing-surface-strong);
}

.film-track {
  position: relative;
  flex: 1;
  height: 0.25rem;
  overflow: hidden;
  border-radius: 0.125rem;
  background: var(--landing-border);
  cursor: pointer;
}

.film-fill {
  height: 100%;
  background: var(--landing-accent);
}

.film-time {
  min-width: 2.75rem;
  color: var(--landing-muted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  text-align: right;
}
</style>
