<template>
  <figure
    v-if="hasFilm"
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
        :style="{ aspectRatio: `${width} / ${height}` }"
      >
        <div
          ref="host"
          class="film-stage"
          role="img"
          :aria-label="label"
        />
        <!-- The first state as a still until the player has drawn the same frame. -->
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
        :aria-valuemax="duration"
        :aria-valuenow="frame"
        @pointerdown="seekFromPointer"
        @keydown.left.prevent="seekBy(-30)"
        @keydown.right.prevent="seekBy(30)"
      >
        <div
          class="film-fill"
          :style="{ width: `${(frame / Math.max(duration - 1, 1)) * 100}%` }"
        />
      </div>
      <span class="film-time">{{ time }}</span>
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
import {
    useIntersectionObserver,
    usePreferredReducedMotion,
} from '@vueuse/core';
import type { IPlayerHandle } from '~/films/mountComposition';
import {
    resolveFilmVariant,
    type TCompositionId,
    type TFilmTheme,
} from '~/films/registry';

const {
    id,
    locale,
    theme,
} = defineProps<{
    id: TCompositionId
    locale: string
    theme: TFilmTheme
    label: string
    playLabel: string
    pauseLabel: string
    positionLabel: string
    title: string
    width: number
    height: number
}>();

const host = useTemplateRef<HTMLElement>('host');
const reducedMotion = usePreferredReducedMotion();
const frame = ref(0);
const duration = ref(1);
const playing = ref(false);
const showPoster = ref(true);
const visible = ref(false);
let handle: IPlayerHandle | null = null;
/** The film has drawn content; playback may start. */
let ready = false;
let mountVersion = 0;

const hasFilm = computed(() => resolveFilmVariant(id, locale, theme) !== null);
// CSS selects the poster that matches the color mode already set on the html element.
const posterUrl = (posterTheme: TFilmTheme) => {
    const variant = resolveFilmVariant(id, locale, posterTheme);
    return variant ? `url(/films/${variant.path}/poster.jpg)` : 'none';
};
const posterStyle = computed(() => ({
    '--poster-light': posterUrl('light'),
    '--poster-dark': posterUrl('dark'),
}));

const time = computed(() => {
    const seconds = frame.value / 30;
    return `${Math.floor(seconds)}.${Math.floor((seconds % 1) * 10)}s`;
});

async function mountVariant() {
    const version = ++mountVersion;
    handle?.unmount();
    handle = null;
    ready = false;
    playing.value = false;
    frame.value = 0;
    duration.value = 1;
    showPoster.value = true;
    if (!host.value || !hasFilm.value) {
        return;
    }

    const { mountComposition } = await import('~/films/mountComposition');
    const mounted = await mountComposition(host.value, id, locale, theme, {
        reducedMotion: reducedMotion.value === 'reduce',
        onReady: () => {
            if (version !== mountVersion) {
                return;
            }
            // Two frames: the player's first content frame is painted before the poster goes.
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (version !== mountVersion) {
                    return;
                }
                showPoster.value = false;
                ready = true;
                if (visible.value && reducedMotion.value !== 'reduce') {
                    mounted.play();
                }
            }));
        },
        onFrame: (value) => {
            frame.value = value;
        },
        onPlayingChange: (value) => {
            playing.value = value;
        },
    });
    if (version !== mountVersion) {
        mounted.unmount();
        return;
    }
    handle = mounted;
    duration.value = mounted.durationInFrames;
    frame.value = mounted.initialFrame;
}

function toggle() {
    handle?.toggle();
}

function seekBy(frames: number) {
    handle?.seekTo(Math.min(duration.value - 1, Math.max(0, frame.value + frames)));
}

function seekFromPointer(event: PointerEvent) {
    if (!(event.currentTarget instanceof HTMLElement)) {
        return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const seek = (clientX: number) => {
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        handle?.seekTo(Math.round(ratio * (duration.value - 1)));
    };
    seek(event.clientX);
    const move = (moveEvent: PointerEvent) => seek(moveEvent.clientX);
    const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
}

onMounted(() => {
    void mountVariant();
});

watch(() => [
    locale,
    theme,
], () => {
    void mountVariant();
});

// Plays only while on screen.
useIntersectionObserver(host, ([entry]) => {
    visible.value = Boolean(entry?.isIntersecting);
    if (!ready || reducedMotion.value === 'reduce') {
        return;
    }
    if (visible.value) {
        handle?.play();
    } else {
        handle?.pause();
    }
});

onBeforeUnmount(() => {
    mountVersion++;
    handle?.unmount();
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

.film-stage,
.film-poster {
  position: absolute;
  inset: 0;
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
