import {workspaceCommandSinkKey} from '@app/types/workspaceCommand';
import type {
    IScanCleanupMarginsMm,
    IScanCleanupManualZones,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    IScanCleanupPreviewResult,
    TScanCleanupOutputHalf,
    TScanCleanupOutputMode,
    TScanCleanupPageOutputMapping,
    TScanCleanupPageAlignment,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {Ref} from 'vue';
import {isEqual} from 'es-toolkit/predicate';
import {
    omit,
    omitBy,
} from 'es-toolkit/object';
import {tryOnScopeDispose} from '@vueuse/core';
import {cloneScanCleanupPreferenceValue} from '@contracts/scan-cleanup/scanCleanupSettings';
import {
    attachScanCleanupPageOverrideDefaults,
    DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {
    resolveScanCleanupMarginsMm,
    resolveScanCleanupOutputPlacement,
} from '@evb/scan-cleanup/core/policy/scanCleanupPagePolicy';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    resolveScanCleanupSelection,
    type TScanCleanupOrderedPages,
    type TScanCleanupSelectionIntent,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';
import {
    resolveScanCleanupApplyScope,
    type TScanCleanupApplyScope,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupApplyScope';
import {
    resolveScanCleanupMixedValue,
    updateScanCleanupPageOverrideRotation,
    updateScanCleanupPageOverrides,
} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';
import {
    resolveScanCleanupMarginPatch,
    scanCleanupMarginsUniform,
    type TScanCleanupMarginTarget,
} from '@app/modules/scan-cleanup/runtime/updateScanCleanupMargins';

interface IUseScanCleanupSelectionOptions {
    initialPage: number;
    previewResult: () => IScanCleanupPreviewResult | null;
    previewTotalPages: () => number;
    settings: IScanCleanupOptions;
    marginsLinked: Ref<boolean>;
}

interface IScanCleanupDocumentReplacement {
    defaultPage: number;
    pageCount: number;
    pageMapping?: TScanCleanupPageOutputMapping | null;
}

export type TScanCleanupSettingsScope = 'all' | 'page' | 'selected';
export type TScanCleanupOverrideControl =
    | 'layout'
    | 'output-mode'
    | 'rotation'
    | 'inclusion'
    | 'margins'
    | 'placement';

export const useScanCleanupSelection = (options: IUseScanCleanupSelectionOptions) => {
    const {settings} = options;
    attachScanCleanupPageOverrideDefaults(
        settings.pageOverrides,
        settings.pageOverrideDefaults,
        settings.marginsMm,
    );
    const leader = ref(options.initialPage);
    const anchor = ref(options.initialPage);
    const selectedPages = shallowRef<ReadonlySet<number>>(new Set([options.initialPage]));
    const settingsScope = ref<TScanCleanupSettingsScope>('all');
    const highlightedScope = ref<TScanCleanupSettingsScope | null>(null);
    let highlightTimer: ReturnType<typeof setTimeout> | null = null;
    const currentPageOverride = computed(() => getScanCleanupPageOverride(
        settings.pageOverrides,
        requirePageNumber(leader.value),
        settings.pageOverrideDefaults,
        settings.marginsMm,
    ));
    const selectedPageNumbers = computed(() => [...selectedPages.value].sort((left, right) => left - right));
    const selectedPageOverrides = computed(() => selectedPageNumbers.value
        .map(page => getScanCleanupPageOverride(
            settings.pageOverrides,
            requirePageNumber(page),
            settings.pageOverrideDefaults,
            settings.marginsMm,
        )));
    const mixed = <T>(read: (override: (typeof selectedPageOverrides.value)[number]) => T) => computed(() => resolveScanCleanupMixedValue(selectedPageOverrides.value.map(read)));
    const layoutOverride = mixed(override => override.layoutOverride);
    const rotation = mixed(override => override.rotationDegrees);
    const outputModeOverride = mixed(override => override.outputModeOverride);
    const excluded = mixed(override => override.excluded);
    const manualSplit = mixed(override => override.manualSplit);
    const manualSkew = mixed(override => override.manualSkewDegrees);
    const contentBoxes = mixed(override => override.manualContentBoxes ?? {});
    const margins = mixed(override => resolveScanCleanupMarginsMm(settings.marginsMm, override));
    const hasMarginOverrides = computed(() => selectedPageOverrides.value
        .some(override => override.marginsMm !== undefined));
    const placementAlignment = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.flatMap(override => ([
            'full',
            'left',
            'right',
        ] as const)
            .map(half => resolveScanCleanupOutputPlacement(settings.pageAlignment, override, half))),
    ));
    const currentOutputHalves = computed<TScanCleanupOutputHalf[]>(() => {
        const result = options.previewResult();
        const halves = result?.pageNumber === leader.value
            ? result.outputs.map(output => output.metadata.half)
            : [];
        return halves.length > 0 ? halves : ['full'];
    });
    const currentPlacementAlignment = computed(() => {
        const alignments = currentOutputHalves.value.map(half => resolveScanCleanupOutputPlacement(
            settings.pageAlignment,
            currentPageOverride.value,
            half,
        ));
        return alignments.every(alignment => alignment === alignments[0])
            ? alignments[0] ?? settings.pageAlignment
            : null;
    });

    // Override edits join the document's undo history where the workspace provides it.
    const commandSink = getCurrentInstance() ? inject(workspaceCommandSinkKey, undefined) : undefined;
    tryOnScopeDispose(() => commandSink?.reset('scan-cleanup'));

    // One edit, one undo step that replays only the page defaults and entries
    // of `pages` it changed, so a later edit of another page stays.
    function recordOverrideEdit(pages: readonly number[], edit: () => void) {
        const fields = [
            'pageOverrideDefaults',
            'pageAlignment',
            'marginsMm',
        ];
        const keys = [
            ...fields,
            ...pages.map(String),
        ];
        const target = (key: string) => fields.includes(key) ? settings : settings.pageOverrides;
        const read = () => keys.map(key => cloneScanCleanupPreferenceValue<unknown>(Reflect.get(target(key), key)));
        const before = read();
        edit();
        const after = read();
        const changed = keys.flatMap((key, index) => isEqual(before[index], after[index]) ? [] : [{
            key,
            before: before[index],
            after: after[index],
        }]);
        if (changed.length === 0) return;
        const apply = (side: 'before' | 'after') => {
            for (const entry of changed) {
                const owner = target(entry.key);
                if (entry[side] === undefined) Reflect.deleteProperty(owner, entry.key);
                else Reflect.set(owner, entry.key, cloneScanCleanupPreferenceValue(entry[side]));
            }
            attachScanCleanupPageOverrideDefaults(settings.pageOverrides, settings.pageOverrideDefaults, settings.marginsMm);
            return true;
        };
        commandSink?.register({
            source: 'scan-cleanup',
            estimatedBytes: JSON.stringify(changed).length * 2,
            undo: () => apply('before'),
            cmd: () => apply('after'),
        });
    }

    // An All-scope edit sets the page defaults first.
    function updateOverrides(
        pages: Iterable<number>,
        update: Parameters<typeof updateScanCleanupPageOverrides>[2],
        defaults?: IScanCleanupPageOverride,
    ) {
        const selected = [...new Set(pages)];
        recordOverrideEdit(selected, () => {
            if (defaults) setPageOverrideDefaults(defaults);
            updateScanCleanupPageOverrides(settings.pageOverrides, selected, update, settings.marginsMm);
        });
    }

    function setPageOverrideDefaults(value: IScanCleanupPageOverride, pageOverrides = settings.pageOverrides) {
        settings.pageOverrideDefaults = createScanCleanupPageOverride(value);
        settings.pageOverrides = pageOverrides;
        attachScanCleanupPageOverrideDefaults(pageOverrides, settings.pageOverrideDefaults, settings.marginsMm);
    }

    function updatePageOverride(page: number, value: IScanCleanupPageOverride) {
        updateOverrides([page], previous => updateScanCleanupPageOverrideRotation(
            {
                ...value,
                rotationDegrees: previous.rotationDegrees,
            },
            value.rotationDegrees,
        ));
    }

    function updateLayoutOverride(
        value: TScanCleanupPageLayoutOverride,
        pages: Iterable<number> = selectedPages.value,
    ) {
        updateOverrides(pages, current => ({
            ...current,
            layoutOverride: value,
        }));
    }

    function updateRotation(
        value: TScanCleanupPageRotation,
        pages: Iterable<number> = selectedPages.value,
    ) {
        updateOverrides(pages, current => updateScanCleanupPageOverrideRotation(current, value));
    }

    function updateExcluded(value: boolean, pages: Iterable<number> = selectedPages.value) {
        updateOverrides(pages, current => ({
            ...current,
            excluded: value,
        }));
    }

    function updateOutputModeOverride(
        value: TScanCleanupOutputMode | 'auto',
        pages: Iterable<number> = selectedPages.value,
    ) {
        updateOverrides(pages, current => value === 'auto' ? omit(current, ['outputModeOverride']) : {
            ...current,
            outputModeOverride: value,
        });
    }

    function resetManualSplit(pages: Iterable<number> = selectedPages.value) {
        updateOverrides(pages, current => ({
            ...current,
            manualSplit: null,
        }));
    }

    function updateManualSkew(
        value: number | undefined,
        pages: Iterable<number> = selectedPages.value,
    ) {
        updateOverrides(pages, current => ({
            ...current,
            manualSkewDegrees: value,
        }));
    }

    function resetManualSkew(pages: Iterable<number> = selectedPages.value) {
        updateManualSkew(undefined, pages);
    }

    function resetContentBoxes(pages: Iterable<number> = selectedPages.value) {
        updateOverrides(pages, current => ({
            ...current,
            manualContentBoxes: {},
        }));
    }

    function updateMargins(
        target: TScanCleanupMarginTarget,
        value: number,
        pages: Iterable<number> = selectedPages.value,
    ) {
        const effectiveTarget = options.marginsLinked.value ? 'all' : target;
        updateOverrides(pages, current => ({
            ...current,
            marginsMm: {
                ...resolveScanCleanupMarginsMm(settings.marginsMm, current),
                ...resolveScanCleanupMarginPatch(effectiveTarget, value),
            },
        }));
    }

    function setMarginsLinked(
        linked: boolean,
        pages: Iterable<number> = selectedPages.value,
        effectiveMargins?: IScanCleanupMarginsMm,
    ) {
        options.marginsLinked.value = linked;
        const effective = effectiveMargins === undefined
            ? margins.value
            : resolveScanCleanupMixedValue([effectiveMargins]);
        if (linked && !effective.mixed && effective.value && !scanCleanupMarginsUniform(effective.value)) {
            updateMargins('all', effective.value.topMm, pages);
        }
    }

    function resetMargins(pages: Iterable<number> = selectedPages.value) {
        updateOverrides(pages, current => omit(current, ['marginsMm']));
    }

    function resetControlOverride(
        control: TScanCleanupOverrideControl,
        pages: Iterable<number> = selectedPages.value,
    ) {
        updateOverrides(pages, current => {
            if (control === 'layout') {
                return {
                    ...current,
                    layoutOverride: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.layoutOverride,
                };
            }
            if (control === 'rotation') {
                return updateScanCleanupPageOverrideRotation(
                    current,
                    DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotationDegrees,
                );
            }
            if (control === 'output-mode') {
                return omit(current, ['outputModeOverride']);
            }
            if (control === 'inclusion') {
                return {
                    ...current,
                    excluded: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.excluded,
                };
            }
            if (control === 'margins') {
                return omit(current, ['marginsMm']);
            }
            return omit(current, ['placementOverrides']);
        });
    }

    function updatePlacement(
        value: TScanCleanupPageAlignment,
        pages: Iterable<number> = selectedPages.value,
    ) {
        updateOverrides(pages, current => ({
            ...current,
            placementOverrides: {
                ...current.placementOverrides,
                full: value,
                left: value,
                right: value,
            },
        }));
    }

    function applyLeaderOverrides(scope: TScanCleanupApplyScope) {
        if (scope === 'all') {
            // The all-pages action is a document-wide value, not a million
            // individual writes. Existing page entries are true sparse
            // exceptions, so replacing the map is exact.
            const pageOverride = currentPageOverride.value;
            recordOverrideEdit(Object.keys(settings.pageOverrides).map(Number), () => setPageOverrideDefaults(pageOverride, {}));
            return;
        }
        const pages = resolveScanCleanupApplyScope({
            leader: leader.value,
            pageCount: options.previewTotalPages(),
            selectedPages: selectedPages.value,
        }, scope);
        updateOverrides(pages, () => currentPageOverride.value);
    }

    function updateCurrentManualSplit(value: IScanCleanupNormalizedSplit | null) {
        updatePageOverride(leader.value, {
            ...currentPageOverride.value,
            manualSplit: value,
        });
    }

    function updateCurrentManualContentBox(
        half: TScanCleanupOutputHalf,
        value: IScanCleanupNormalizedRect | null,
    ) {
        const manualContentBoxes = {...currentPageOverride.value.manualContentBoxes};
        if (value) manualContentBoxes[half] = value;
        else Reflect.deleteProperty(manualContentBoxes, half);
        updatePageOverride(leader.value, {
            ...currentPageOverride.value,
            manualContentBoxes,
        });
    }

    function updateCurrentManualZones(value: IScanCleanupManualZones) {
        updatePageOverride(leader.value, {
            ...currentPageOverride.value,
            manualZones: value,
        });
    }

    function updateCurrentPlacement(half: TScanCleanupOutputHalf, value: TScanCleanupPageAlignment | null) {
        const placementOverrides = {...currentPageOverride.value.placementOverrides};
        if (value) placementOverrides[half] = value;
        else Reflect.deleteProperty(placementOverrides, half);
        updatePageOverride(leader.value, {
            ...currentPageOverride.value,
            placementOverrides,
        });
    }

    function updateCurrentPlacementAll(value: TScanCleanupPageAlignment) {
        const pages = Object.keys(settings.pageOverrides).map(Number);
        const removeMatchingPlacement = (current: IScanCleanupPageOverride) => ({
            ...current,
            placementOverrides: omitBy(current.placementOverrides ?? {}, alignment => alignment === value),
        });
        recordOverrideEdit(pages, () => {
            settings.pageAlignment = value;
            if (settings.pageOverrideDefaults !== undefined) {
                setPageOverrideDefaults(removeMatchingPlacement(settings.pageOverrideDefaults));
            }
            updateScanCleanupPageOverrides(settings.pageOverrides, pages, removeMatchingPlacement, settings.marginsMm);
        });
    }

    function resetOverrides(pages: Iterable<number>) {
        updateOverrides(pages, () => createScanCleanupPageOverride());
    }

    function setSettingsScope(value: TScanCleanupSettingsScope) {
        if (value === 'selected' && selectedPages.value.size < 2) {
            return;
        }
        settingsScope.value = value;
    }

    function highlightSettingsScope(value: TScanCleanupSettingsScope) {
        settingsScope.value = value;
        highlightedScope.value = value;
        if (highlightTimer !== null) {
            clearTimeout(highlightTimer);
        }
        highlightTimer = setTimeout(() => {
            highlightedScope.value = null;
            highlightTimer = null;
        }, 250);
    }

    function selectPage(page: number, intent: TScanCleanupSelectionIntent, orderedPages: TScanCleanupOrderedPages) {
        const previousCount = selectedPages.value.size;
        const selection = resolveScanCleanupSelection({
            anchor: anchor.value,
            leader: leader.value,
            selectedPages: selectedPages.value,
        }, page, intent, orderedPages);
        anchor.value = selection.anchor;
        leader.value = selection.leader;
        selectedPages.value = selection.selectedPages;
        if (intent !== 'single' && selection.selectedPages.size >= 2) {
            highlightSettingsScope('selected');
        } else if (previousCount >= 2 && selection.selectedPages.size <= 1) {
            highlightSettingsScope('page');
        }
    }

    function resetSelection(pageCount: number, page: number) {
        const normalizedPageCount = Math.max(1, Math.trunc(pageCount));
        const nextPage = Math.min(Math.max(1, Math.trunc(page)), normalizedPageCount);
        anchor.value = nextPage;
        leader.value = nextPage;
        selectedPages.value = new Set([nextPage]);
        settingsScope.value = 'all';
        highlightedScope.value = null;
    }

    function resetToLeader(pageCount: number) {
        resetSelection(pageCount, leader.value);
    }

    function reconcilePageCount(pageCount: number, defaultPage: number) {
        const normalizedPageCount = Math.max(1, Math.trunc(pageCount));
        const selectionIsValid = leader.value >= 1
            && leader.value <= normalizedPageCount
            && anchor.value >= 1
            && anchor.value <= normalizedPageCount
            && selectedPages.value.size > 0
            && [...selectedPages.value].every(page => page >= 1 && page <= normalizedPageCount);
        if (!selectionIsValid) {
            resetSelection(normalizedPageCount, defaultPage);
        }
    }

    function reconcileDocumentReplacement(replacement: IScanCleanupDocumentReplacement) {
        const normalizedPageCount = Math.max(1, Math.trunc(replacement.pageCount));
        const pageMapping = replacement.pageMapping;
        if (!pageMapping) {
            resetSelection(normalizedPageCount, replacement.defaultPage);
            return;
        }

        const sourcePages = new Set([
            leader.value,
            anchor.value,
            ...selectedPages.value,
        ]);
        const mappedPages = new Map<number, number>();
        for (const sourcePage of sourcePages) {
            const outputPages = pageMapping[String(sourcePage)];
            if (outputPages?.length !== 1) {
                resetSelection(normalizedPageCount, replacement.defaultPage);
                return;
            }
            const outputPage = outputPages[0];
            if (outputPage === undefined
                || outputPage < 1
                || outputPage > normalizedPageCount) {
                resetSelection(normalizedPageCount, replacement.defaultPage);
                return;
            }
            mappedPages.set(sourcePage, outputPage);
        }

        const mappedSelectedPages = [...selectedPages.value].map(page => mappedPages.get(page));
        if (mappedSelectedPages.some(page => page === undefined)
            || new Set(mappedSelectedPages).size !== mappedSelectedPages.length) {
            resetSelection(normalizedPageCount, replacement.defaultPage);
            return;
        }

        const mappedLeader = mappedPages.get(leader.value);
        const mappedAnchor = mappedPages.get(anchor.value);
        if (mappedLeader === undefined || mappedAnchor === undefined) {
            resetSelection(normalizedPageCount, replacement.defaultPage);
            return;
        }
        leader.value = mappedLeader;
        anchor.value = mappedAnchor;
        selectedPages.value = new Set(mappedSelectedPages as number[]);
        highlightedScope.value = null;
    }

    onScopeDispose(() => {
        if (highlightTimer !== null) {
            clearTimeout(highlightTimer);
        }
    }, true);

    return {
        recordOverrideEdit,
        applyLeaderOverrides,
        contentBoxes,
        currentPageOverride,
        currentPlacementAlignment,
        excluded,
        layoutOverride,
        leader,
        margins,
        marginsLinked: options.marginsLinked,
        setPageOverrideDefaults,
        manualSplit,
        manualSkew,
        outputModeOverride,
        hasMarginOverrides,
        highlightedScope,
        placementAlignment,
        resetContentBoxes,
        resetControlOverride,
        resetMargins,
        resetManualSplit,
        resetManualSkew,
        reconcileDocumentReplacement,
        reconcilePageCount,
        resetOverrides,
        resetToLeader,
        rotation,
        selectPage,
        selectedPages,
        setMarginsLinked,
        setSettingsScope,
        settingsScope,
        updateCurrentManualContentBox,
        updateCurrentManualSplit,
        updateCurrentManualZones,
        updateCurrentPlacement,
        updateCurrentPlacementAll,
        updateExcluded,
        updateLayoutOverride,
        updateMargins,
        updateManualSkew,
        updateOutputModeOverride,
        updatePageOverride,
        updateOverrides,
        updatePlacement,
        updateRotation,
    };
};
