<template>
    <UIcon
        name="i-ph-circle-notch"
        :class="[sizeClass, toneClass, 'animate-spin motion-reduce:animate-none']"
        aria-hidden="true"
    />
</template>

<script setup lang="ts">
type TSpinnerSize = 'xs' | 'sm' | 'md' | 'lg';
type TSpinnerTone = 'muted' | 'primary' | 'inherit';

interface IAppSpinnerProps {
    size?: TSpinnerSize;
    tone?: TSpinnerTone;
}

const {size = 'md', tone = 'muted'} = defineProps<IAppSpinnerProps>();

const sizeClass = computed(() => {
    switch (size) {
        case 'xs':
            return 'size-3.5';
        case 'sm':
            return 'size-4';
        case 'lg':
            return 'size-8';
        case 'md':
            return 'size-5';
    }
});

const toneClass = computed(() => {
    switch (tone) {
        case 'primary':
            return 'text-[var(--ui-primary)]';
        case 'inherit':
            return '';
        case 'muted':
            return 'text-[var(--ui-text-muted)]';
    }
});
</script>
