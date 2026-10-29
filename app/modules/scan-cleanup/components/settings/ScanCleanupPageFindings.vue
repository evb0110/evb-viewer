<template>
    <div class="scan-cleanup-page-findings" :data-page-findings="pageNumber">
        <p
            v-for="hint in attentionHints"
            :key="hint"
            class="scan-cleanup-page-findings-notice"
        >
            <UIcon name="i-ph-warning" aria-hidden="true" />
            <span>{{ hint }}</span>
        </p>
        <details v-if="diagnosticGroups.length > 0" class="scan-cleanup-page-findings-technical">
            <summary>{{ t('scanCleanup.pages.technicalDetails') }}</summary>
            <dl>
                <div
                    v-for="group in diagnosticGroups"
                    :key="group.title"
                    class="scan-cleanup-page-findings-group"
                >
                    <h4>{{ group.title }}</h4>
                    <div
                        v-for="note in group.notes"
                        :key="note"
                        class="scan-cleanup-page-findings-note"
                    >{{ note }}</div>
                    <div
                        v-for="(row, rowIndex) in group.rows"
                        :key="`${group.title}-${rowIndex}`"
                        class="scan-cleanup-page-findings-row"
                    >
                        <dt>{{ row.label }}</dt>
                        <dd>{{ row.value }}</dd>
                    </div>
                </div>
            </dl>
        </details>
    </div>
</template>

<script setup lang="ts">
import {
    scanCleanupPageAttentionHints,
    scanCleanupPageDiagnosticGroups,
    type IScanCleanupPageFacts,
} from '@app/modules/scan-cleanup/runtime/describeScanCleanupPage';

const props = defineProps<{
    facts: IScanCleanupPageFacts;
    pageNumber: number;
}>();
const {t} = useTypedI18n();
const attentionHints = computed(() => scanCleanupPageAttentionHints(t, props.facts));
const diagnosticGroups = computed(() => scanCleanupPageDiagnosticGroups(t, props.facts));
</script>

<style scoped>
.scan-cleanup-page-findings {
    display: grid;
    gap: var(--app-space-3xl);
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-page-findings:empty {
    display: none;
}

.scan-cleanup-page-findings-notice {
    display: flex;
    align-items: start;
    gap: var(--app-space-3xl);
    border-radius: var(--app-radius-md);
    background: color-mix(in srgb, var(--ui-warning) 12%, var(--ui-bg));
    padding: var(--app-space-3xl);
    margin: 0;
    color: var(--ui-text);
    line-height: var(--app-line-height-body);
}

.scan-cleanup-page-findings-notice > :first-child {
    flex: none;
    margin-block-start: var(--app-space-2xs);
    color: var(--ui-warning);
}

.scan-cleanup-page-findings-technical > summary {
    color: var(--ui-text-muted);
    cursor: pointer;
    font-size: var(--app-text-size-kicker);
}

.scan-cleanup-page-findings-technical dl {
    display: grid;
    gap: var(--app-space-5xl);
    padding-block-start: var(--app-space-3xl);
    margin: 0;
}

.scan-cleanup-page-findings-group {
    display: grid;
    gap: var(--app-space-3xl);
}

.scan-cleanup-page-findings-group h4 {
    margin: 0;
    color: var(--ui-text);
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-heading);
    text-transform: uppercase;
}

.scan-cleanup-page-findings-row {
    display: flex;
    justify-content: space-between;
    gap: var(--app-space-3xl);
    font-size: var(--app-text-size-kicker);
}

.scan-cleanup-page-findings-row dt,
.scan-cleanup-page-findings-note {
    color: var(--ui-text-muted);
}

.scan-cleanup-page-findings-row dd {
    max-width: 68%;
    margin: 0;
    text-align: end;
    overflow-wrap: anywhere;
}

.scan-cleanup-page-findings-note {
    font-size: var(--app-text-size-kicker);
}
</style>
