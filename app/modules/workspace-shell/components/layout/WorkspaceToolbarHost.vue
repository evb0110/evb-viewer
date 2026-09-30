<template>
    <Teleport
        v-if="isActive && canTeleport"
        to="#editor-global-toolbar-host"
    >
        <slot />
    </Teleport>
</template>

<script setup lang="ts">
defineProps<{
    isActive: boolean;
    canTeleport: boolean;
}>();
</script>
