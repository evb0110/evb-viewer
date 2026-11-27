import {workspaceCommandSinkKey} from '@app/types/workspaceCommand';
import type {useScanCleanupDocumentSettings} from '@app/modules/scan-cleanup/composables/useScanCleanupDocumentSettings';
import type {
    IScanCleanupManualZones,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    TScanCleanupOutputHalf,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageOutputMapping,
    TScanCleanupPageAlignment,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {Ref} from 'vue';
import {isEqual} from 'es-toolkit/predicate';
import {omit, omitBy} from 'es-toolkit/object';
import {tryOnScopeDispose, useTimeoutFn} from '@vueuse/core';
import {cloneScanCleanupPreferenceValue} from '@contracts/scan-cleanup/scanCleanupSettings';
import {
    attachScanCleanupPageOverrideDefaults,
    DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {resolveScanCleanupMarginsMm} from '@evb/scan-cleanup/core/policy/scanCleanupPagePolicy';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    resolveScanCleanupSelection,
    type TScanCleanupOrderedPages,
    type TScanCleanupSelectionIntent,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';
import {resolveScanCleanupApplyScope, type TScanCleanupApplyScope} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupApplyScope';
import {
    resolveScanCleanupMixedValue,
    updateScanCleanupPageOverrideRotation,
    updateScanCleanupPageOverrides,
    type TScanCleanupPageOverrideUpdate,
} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';
import {
    resolveScanCleanupMarginPatch,
    scanCleanupMarginsUniform,
    type TScanCleanupMarginTarget,
} from '@app/modules/scan-cleanup/runtime/updateScanCleanupMargins';

interface IUseScanCleanupSelectionOptions {
    initialPage: number;
    previewTotalPages: () => number;
    settings: IScanCleanupOptions;
    editDocumentSettings: ReturnType<typeof useScanCleanupDocumentSettings>['editDocumentSettings'];
    marginsLinked: Ref<boolean>;
    updateDocumentMargin?: (target: TScanCleanupMarginTarget, value: number) => void;
    setDocumentMarginsLinked?: (linked: boolean) => void;
    resetPageOverrides?: () => void;
    /** Writes a new leader, the preview page, to the tab's view state. */
    saveLeader?: () => void;
}

interface IScanCleanupDocumentReplacement {
    defaultPage: number;
    pageCount: number;
    pageMapping?: TScanCleanupPageOutputMapping | null;
}

export type TScanCleanupSettingsScope = 'all' | 'page' | 'selected';
export type TScanCleanupOverrideControl = 'layout' | 'output-mode' | 'rotation' | 'inclusion' | 'margins' | 'placement';

// Shared document-level preferences (`layoutMode`, `pageAlignment`) span open
// workspaces, while undo ledgers belong to one document. Track the last command
// that wrote each shared field so undo/redo never clobbers another document's edit.
const sharedFieldOwner = new Map<string, symbol>();

export const useScanCleanupSelection = (options: IUseScanCleanupSelectionOptions) => {
    const {settings, editDocumentSettings} = options;
    attachScanCleanupPageOverrideDefaults(settings.pageOverrides, settings.pageOverrideDefaults, settings.marginsMm);
    const leaderPage = ref(options.initialPage);
    const leader = computed({
        get: () => leaderPage.value,
        set: (page: number) => {
            if (page === leaderPage.value) {
                return;
            }
            leaderPage.value = page;
            options.saveLeader?.();
        },
    });
    const anchor = ref(options.initialPage);
    const selectedPages = shallowRef<ReadonlySet<number>>(new Set([options.initialPage]));
    const settingsScope = ref<TScanCleanupSettingsScope>('all');
    const highlightedScope = ref<TScanCleanupSettingsScope | null>(null);
    const highlightReset = useTimeoutFn(
        () => {
            highlightedScope.value = null;
        },
        250,
        {immediate: false},
    );
    const currentPageOverride = computed(() => getPageOverride(leader.value));
    const selectedPageNumbers = computed(() => [...selectedPages.value].sort((left, right) => left - right));

    function getPageOverride(page: number) {
        return getScanCleanupPageOverride(
            settings.pageOverrides,
            requirePageNumber(page),
            settings.pageOverrideDefaults,
            settings.marginsMm,
        );
    }

    function allScopeDefaultOverride() {
        return settings.pageOverrideDefaults ?? createScanCleanupPageOverride();
    }

    function existingOverridePages() {
        const totalPages = Math.max(1, options.previewTotalPages());
        return Object.keys(settings.pageOverrides)
            .map(Number)
            .filter((page) => Number.isSafeInteger(page) && page >= 1 && page <= totalPages);
    }

    function scopeTargetPages() {
        return settingsScope.value === 'page' ? [leader.value] : selectedPageNumbers.value;
    }

    // Override edits join the document's undo history where the workspace provides it.
    const commandSink = getCurrentInstance() ? inject(workspaceCommandSinkKey, undefined) : undefined;
    tryOnScopeDispose(() => commandSink?.reset('scan-cleanup'));

    // One edit, one undo step that replays only the page defaults and entries
    // of `pages` it changed, so a later edit of another page stays.
    function recordOverrideEdit(pages: readonly number[], edit: () => void) {
        const fields = ['pageOverrideDefaults', 'pageAlignment', 'marginsMm', 'layoutMode'];
        const sharedFields = new Set(['pageAlignment', 'layoutMode']);
        const keys = [...fields, ...pages.map(String)];
        const target = (key: string) => (fields.includes(key) ? settings : settings.pageOverrides);
        const read = () => keys.map((key) => cloneScanCleanupPreferenceValue<unknown>(Reflect.get(target(key), key)));
        const before = read();
        const beforeMarginsLinked = options.marginsLinked.value;
        editDocumentSettings(pages, edit);
        const after = read();
        const afterMarginsLinked = options.marginsLinked.value;
        const changed = keys.flatMap((key, index) =>
            isEqual(before[index], after[index])
                ? []
                : [
                      {
                          key,
                          before: before[index],
                          after: after[index],
                      },
                  ],
        );
        if (changed.length === 0) {
            return;
        }
        const commandToken = Symbol('scan-cleanup-override-edit');
        const previousOwners = new Map<string, symbol | undefined>();
        for (const entry of changed) {
            if (!sharedFields.has(entry.key)) {
                continue;
            }
            previousOwners.set(entry.key, sharedFieldOwner.get(entry.key));
            sharedFieldOwner.set(entry.key, commandToken);
        }
        const skippedSharedFields = new Set<string>();
        const marginsLinkedChanged = beforeMarginsLinked !== afterMarginsLinked;
        // Undo and redo are edits too, persisted like the edit they replay.
        const apply = (side: 'before' | 'after') => {
            const opposite = side === 'before' ? 'after' : 'before';
            editDocumentSettings(
                changed.flatMap(({key}) => (fields.includes(key) ? [] : [key])),
                () => {
                    for (const entry of changed) {
                        const owner = target(entry.key);
                        if (sharedFields.has(entry.key)) {
                            const expectedOwner = side === 'before' ? commandToken : previousOwners.get(entry.key);
                            if (
                                skippedSharedFields.has(entry.key) ||
                                sharedFieldOwner.get(entry.key) !== expectedOwner ||
                                !isEqual(Reflect.get(owner, entry.key), entry[opposite])
                            ) {
                                skippedSharedFields.add(entry.key);
                                continue;
                            }
                            const nextOwner = side === 'before' ? previousOwners.get(entry.key) : commandToken;
                            if (nextOwner === undefined) {
                                sharedFieldOwner.delete(entry.key);
                            } else {
                                sharedFieldOwner.set(entry.key, nextOwner);
                            }
                        }
                        if (entry[side] === undefined) {
                            Reflect.deleteProperty(owner, entry.key);
                        } else {
                            Reflect.set(owner, entry.key, cloneScanCleanupPreferenceValue(entry[side]));
                        }
                    }
                },
            );
            if (marginsLinkedChanged) {
                options.marginsLinked.value = side === 'before' ? beforeMarginsLinked : afterMarginsLinked;
            }
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
    function updateOverrides(pages: Iterable<number>, update: TScanCleanupPageOverrideUpdate, defaults?: IScanCleanupPageOverride) {
        const selected = [...new Set(pages)];
        recordOverrideEdit(selected, () => {
            if (defaults) {
                setPageOverrideDefaults(defaults);
            }
            updateScanCleanupPageOverrides(settings.pageOverrides, selected, update, settings.marginsMm);
        });
    }

    function setPageOverrideDefaults(value: IScanCleanupPageOverride, pageOverrides = settings.pageOverrides) {
        editDocumentSettings(Object.keys(settings.pageOverrides), () => {
            settings.pageOverrideDefaults = createScanCleanupPageOverride(value);
            settings.pageOverrides = pageOverrides;
        });
    }

    function updateScopeOverrides(update: TScanCleanupPageOverrideUpdate, updateExisting: TScanCleanupPageOverrideUpdate = update) {
        if (settingsScope.value === 'all') {
            updateOverrides(existingOverridePages(), updateExisting, update(allScopeDefaultOverride(), leader.value));
        } else {
            updateOverrides(scopeTargetPages(), update);
        }
    }

    function updatePageOverride(page: number, value: IScanCleanupPageOverride) {
        updateOverrides([page], (previous) =>
            updateScanCleanupPageOverrideRotation(
                {
                    ...value,
                    rotationDegrees: previous.rotationDegrees,
                },
                value.rotationDegrees,
            ),
        );
    }

    function updatePageMargins(target: TScanCleanupMarginTarget, value: number, pages: Iterable<number>) {
        const effectiveTarget = options.marginsLinked.value ? 'all' : target;
        updateOverrides(pages, (current) => ({
            ...current,
            marginsMm: {
                ...resolveScanCleanupMarginsMm(settings.marginsMm, current),
                ...resolveScanCleanupMarginPatch(effectiveTarget, value),
            },
        }));
    }

    function updateScopeMargins(target: TScanCleanupMarginTarget, value: number) {
        if (settingsScope.value === 'all') {
            recordOverrideEdit(Object.keys(settings.pageOverrides).map(Number), () => {
                setPageOverrideDefaults(omit(allScopeDefaultOverride(), ['marginsMm']));
                if (options.updateDocumentMargin) {
                    options.updateDocumentMargin(target, value);
                } else {
                    Object.assign(settings.marginsMm, resolveScanCleanupMarginPatch(options.marginsLinked.value ? 'all' : target, value));
                }
            });
            return;
        }
        updatePageMargins(target, value, scopeTargetPages());
    }

    function updateScopeLayout(value: IScanCleanupOptions['layoutMode'] | TScanCleanupPageLayoutOverride) {
        if (settingsScope.value === 'all') {
            if (!['auto', 'force-single', 'force-two-page'].includes(value)) {
                return;
            }
            const layoutMode = value as IScanCleanupOptions['layoutMode'];
            const matchingOverride = layoutMode === 'force-single' ? 'single' : layoutMode === 'force-two-page' ? 'spread' : 'auto';
            const resetMatchingPage = (current: IScanCleanupPageOverride) =>
                current.layoutOverride === matchingOverride
                    ? {
                          ...current,
                          layoutOverride: 'auto' as const,
                      }
                    : current;
            const pages = existingOverridePages();
            recordOverrideEdit(pages, () => {
                settings.layoutMode = layoutMode;
                setPageOverrideDefaults({
                    ...allScopeDefaultOverride(),
                    layoutOverride: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.layoutOverride,
                });
                updateScanCleanupPageOverrides(settings.pageOverrides, pages, resetMatchingPage, settings.marginsMm);
            });
            return;
        }
        updateScopeOverrides((current) => ({
            ...current,
            layoutOverride: value as TScanCleanupPageLayoutOverride,
        }));
    }

    function setMarginsLinked(linked: boolean) {
        if (settingsScope.value === 'all') {
            if (!linked) {
                if (options.setDocumentMarginsLinked) {
                    options.setDocumentMarginsLinked(false);
                } else {
                    options.marginsLinked.value = false;
                }
                return;
            }
            recordOverrideEdit(Object.keys(settings.pageOverrides).map(Number), () => {
                if (allScopeDefaultOverride().marginsMm !== undefined) {
                    setPageOverrideDefaults(omit(allScopeDefaultOverride(), ['marginsMm']));
                }
                if (options.setDocumentMarginsLinked) {
                    options.setDocumentMarginsLinked(true);
                } else {
                    options.marginsLinked.value = true;
                    if (!scanCleanupMarginsUniform(settings.marginsMm)) {
                        Object.assign(settings.marginsMm, resolveScanCleanupMarginPatch('all', settings.marginsMm.topMm));
                    }
                }
            });
            return;
        }
        // Page and Selected scopes equalize their own pages' margins, like
        // every other margin edit there; the document's stay as they are.
        const pages = scopeTargetPages();
        const effective = resolveScanCleanupMixedValue(
            pages.map((page) => resolveScanCleanupMarginsMm(settings.marginsMm, getPageOverride(page))),
        );
        if (linked && !effective.mixed && effective.value && !scanCleanupMarginsUniform(effective.value)) {
            const targetTopMm = effective.value.topMm;
            recordOverrideEdit(pages, () => {
                options.marginsLinked.value = true;
                updateScanCleanupPageOverrides(
                    settings.pageOverrides,
                    pages,
                    (current) => ({
                        ...current,
                        marginsMm: {
                            ...resolveScanCleanupMarginsMm(settings.marginsMm, current),
                            ...resolveScanCleanupMarginPatch('all', targetTopMm),
                        },
                    }),
                    settings.marginsMm,
                );
            });
            return;
        }
        options.marginsLinked.value = linked;
    }

    function resetControlOverride(control: TScanCleanupOverrideControl) {
        updateScopeOverrides((current) => {
            if (control === 'layout') {
                return {
                    ...current,
                    layoutOverride: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.layoutOverride,
                };
            }
            if (control === 'rotation') {
                return updateScanCleanupPageOverrideRotation(current, DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotationDegrees);
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

    function updateScopePlacement(value: TScanCleanupPageAlignment) {
        if (settingsScope.value === 'all') {
            const pages = Object.keys(settings.pageOverrides).map(Number);
            const removeMatchingPlacement = (current: IScanCleanupPageOverride) => ({
                ...current,
                placementOverrides: omitBy(current.placementOverrides ?? {}, (alignment) => alignment === value),
            });
            recordOverrideEdit(pages, () => {
                settings.pageAlignment = value;
                if (settings.pageOverrideDefaults !== undefined) {
                    setPageOverrideDefaults(removeMatchingPlacement(settings.pageOverrideDefaults));
                }
                updateScanCleanupPageOverrides(settings.pageOverrides, pages, removeMatchingPlacement, settings.marginsMm);
            });
            return;
        }
        updateOverrides(scopeTargetPages(), (current) => ({
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
        const pages = resolveScanCleanupApplyScope(
            {
                leader: leader.value,
                pageCount: options.previewTotalPages(),
                selectedPages: selectedPages.value,
            },
            scope,
        );
        updateOverrides(pages, () => currentPageOverride.value);
    }

    function updateCurrentManualSplit(value: IScanCleanupNormalizedSplit | null) {
        updatePageOverride(leader.value, {
            ...currentPageOverride.value,
            manualSplit: value,
        });
    }

    function updateCurrentManualContentBox(half: TScanCleanupOutputHalf, value: IScanCleanupNormalizedRect | null) {
        const manualContentBoxes = {...currentPageOverride.value.manualContentBoxes};
        if (value) {
            manualContentBoxes[half] = value;
        } else {
            Reflect.deleteProperty(manualContentBoxes, half);
        }
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
        if (value) {
            placementOverrides[half] = value;
        } else {
            Reflect.deleteProperty(placementOverrides, half);
        }
        updatePageOverride(leader.value, {
            ...currentPageOverride.value,
            placementOverrides,
        });
    }

    function resetScopeOverrides() {
        if (settingsScope.value === 'all') {
            if (options.resetPageOverrides) {
                options.resetPageOverrides();
            } else {
                setPageOverrideDefaults(createScanCleanupPageOverride(), {});
            }
            return;
        }
        updateOverrides(scopeTargetPages(), () => createScanCleanupPageOverride());
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
        highlightReset.start();
    }

    function selectPage(page: number, intent: TScanCleanupSelectionIntent, orderedPages: TScanCleanupOrderedPages) {
        const previousCount = selectedPages.value.size;
        const selection = resolveScanCleanupSelection(
            {
                anchor: anchor.value,
                leader: leader.value,
                selectedPages: selectedPages.value,
            },
            page,
            intent,
            orderedPages,
        );
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
        const selectionIsValid =
            leader.value >= 1 &&
            leader.value <= normalizedPageCount &&
            anchor.value >= 1 &&
            anchor.value <= normalizedPageCount &&
            selectedPages.value.size > 0 &&
            [...selectedPages.value].every((page) => page >= 1 && page <= normalizedPageCount);
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

        const sourcePages = new Set([leader.value, anchor.value, ...selectedPages.value]);
        const mappedPages = new Map<number, number>();
        for (const sourcePage of sourcePages) {
            const outputPages = pageMapping[String(sourcePage)];
            if (outputPages?.length !== 1) {
                resetSelection(normalizedPageCount, replacement.defaultPage);
                return;
            }
            const outputPage = outputPages[0];
            if (outputPage === undefined || outputPage < 1 || outputPage > normalizedPageCount) {
                resetSelection(normalizedPageCount, replacement.defaultPage);
                return;
            }
            mappedPages.set(sourcePage, outputPage);
        }

        const mappedSelectedPages = [...selectedPages.value].map((page) => mappedPages.get(page));
        if (mappedSelectedPages.some((page) => page === undefined) || new Set(mappedSelectedPages).size !== mappedSelectedPages.length) {
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

    return {
        applyLeaderOverrides,
        currentPageOverride,
        highlightedScope,
        leader,
        reconcileDocumentReplacement,
        reconcilePageCount,
        resetControlOverride,
        resetScopeOverrides,
        resetToLeader,
        selectedPages,
        selectPage,
        setMarginsLinked,
        setSettingsScope,
        settingsScope,
        updateCurrentManualContentBox,
        updateCurrentManualSplit,
        updateCurrentManualZones,
        updateCurrentPlacement,
        updatePageOverride,
        updateScopeLayout,
        updateScopeMargins,
        updateScopeOverrides,
        updateScopePlacement,
    };
};
