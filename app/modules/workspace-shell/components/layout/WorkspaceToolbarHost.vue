<template>
    <!--
        The toolbar owns the OCR presenter. While a run is going, a view that
        is not in use keeps its toolbar mounted, hidden, so the run is not
        cancelled by the switch.
    -->
    <Teleport
        v-if="canTeleport && (isActive || keepMounted)"
        to="#editor-global-toolbar-host"
        :disabled="!isActive"
    >
        <div
            v-show="isActive"
            class="workspace-toolbar-slot"
        >
            <slot />
        </div>
    </Teleport>
</template>

<script setup lang="ts">
defineProps<{
    isActive: boolean;
    canTeleport: boolean;
    keepMounted: boolean;
}>();
</script>

<style scoped>
.workspace-toolbar-slot {
    display: contents;
}
</style>
