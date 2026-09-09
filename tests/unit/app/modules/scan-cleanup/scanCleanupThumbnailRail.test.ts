// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
    ref,
    Teleport,
} from 'vue';
import type {
    IScanCleanupPageOverride,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewPageMetadata,
    IScanCleanupTextAxis,
    TScanCleanupPageOverrides,
} from '@contracts/electronApiScanCleanup';
import {requireDocumentRef} from '@contracts/documentRef';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';
import {
    createScanCleanupSparsePageOrder,
    resolveScanCleanupSelection,
    type TScanCleanupSelectionIntent,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';
import AppTooltip from '@app/components/AppTooltip.vue';
import ScanCleanupThumbnailRail from '@app/modules/scan-cleanup/components/ScanCleanupThumbnailRail.vue';

vi.mock('@app/components/document-viewer/DocumentThumbnailList.vue', async () => {
    const vue = await import('vue');
    return {default: vue.defineComponent({
        inheritAttrs: false,
        props: {
            currentPage: {
                type: Number,
                required: true,
            },
            disabled: Boolean,
            selectedPages: {
                type: Object,
                required: true,
            },
            source: {
                type: Object,
                default: null,
            },
        },
        emits: ['go-to-page'],
        setup(props, {
            attrs,
            emit,
            slots,
        }) {
            return () => vue.h('div', {
                ...attrs,
                'data-thumbnail-list-stub': '',
            }, Array.from({length: (props.source as IDocumentPageSource | null)?.pageCount ?? 0}, (_, index) => {
                const position = index + 1;
                return vue.h('div', {
                    class: {'is-disabled': props.disabled},
                    'data-position': position,
                    'data-current': position === props.currentPage ? 'true' : 'false',
                    'data-selected': (props.selectedPages as ReadonlySet<number>).has(position) ? 'true' : 'false',
                    'aria-disabled': props.disabled ? 'true' : undefined,
                    tabindex: props.disabled ? -1 : position === props.currentPage ? 0 : -1,
                    onClick: (event: MouseEvent) => emit('go-to-page', position, event),
                }, [
                    slots.overlay?.({pageNumber: position}),
                    slots.label?.({pageNumber: position}),
                ]);
            }));
        },
    })};
});

const messages: Record<string, string> = {
    'scanCleanup.pages.title': 'Source pages',
    'scanCleanup.pages.count': '{count} source pages',
    'scanCleanup.pages.sort.label': 'Sort pages',
    'scanCleanup.pages.sort.natural': 'Natural order',
    'scanCleanup.pages.sort.classification': 'By layout',
    'scanCleanup.pages.sort.confidence': 'Confidence: low first',
    'scanCleanup.pages.classification.single': 'Single',
    'scanCleanup.pages.classification.spread': 'Spread',
    'scanCleanup.pages.classification.offcut': 'Offcut',
    'scanCleanup.pages.override.auto': 'Auto',
    'scanCleanup.pages.override.single': 'Single page',
    'scanCleanup.pages.override.spread': 'Two-page spread',
    'scanCleanup.pages.override.keepLeft': 'Keep left half',
    'scanCleanup.pages.override.keepRight': 'Keep right half',
    'scanCleanup.pages.overrideFor': 'Layout override for page {page}',
    'scanCleanup.pages.options': 'Page {page} settings',
    'scanCleanup.pages.optionsTitle': 'Page {page}',
    'scanCleanup.pages.technicalDetails': 'Technical details',
    'scanCleanup.pages.detecting': 'Detecting…',
    'scanCleanup.pages.includeInOutput': 'Include in output',
    'scanCleanup.pages.excludedFromOutput': 'Excluded from output',
    'scanCleanup.pages.excludedBadge': 'Excluded',
    'scanCleanup.pages.lowConfidenceHint': 'Detected as "{classification}" with low layout confidence — check this page and set its layout manually if wrong.',
    'scanCleanup.pages.textAxisHint': 'Text appears sideways — set rotation (90° or 270°).',
    'scanCleanup.pages.outputModeFor': 'Output mode for page {page}',
    'scanCleanup.pages.outputModeFollowDocument': 'Follow document setting',
    'scanCleanup.layout.label': 'Page layout',
    'scanCleanup.settings.rotation': 'Rotation',
    'scanCleanup.output.pageLabel': 'Output mode',
    'scanCleanup.pages.outputModeRecommendationHintKnown': 'Recommended output mode: {mode} — {confidence} output-mode confidence. Choose a mode to override it.',
    'scanCleanup.pages.outputModeRecommendationHintUnknown': 'Recommended output mode: {mode}. Choose a mode to override it.',
    'scanCleanup.pages.outputModeRecommendationPending': 'Automatic output-mode recommendation is pending.',
    'scanCleanup.pages.outputModeOverrideHint': 'Page override: {mode}. Choose Follow document setting to use the document setting.',
    'scanCleanup.pages.outputModeDocumentHint': 'Effective mode: {mode} — follows the document setting.',
    'scanCleanup.pages.outputModeLosslessControlHint': 'Per-page output mode is unavailable because preserving original quality forces color.',
    'scanCleanup.pages.rotationFor': 'Rotation for page {page}',
    'scanCleanup.pages.processed': 'Processed',
    'scanCleanup.pages.sourceLoading': 'Loading source pages…',
    'scanCleanup.pages.sourceUnavailable': 'Source pages are unavailable',
    'scanCleanup.pages.sourceUnavailableHint': 'Reopen Scan Cleanup',
    'scanCleanup.pages.detectionPending': 'Detecting page {page}',
    'scanCleanup.pages.diagnostics.modeDecision': 'Mode decision',
    'scanCleanup.pages.diagnostics.contentTrim': 'Content trim',
    'scanCleanup.pages.diagnostics.geometry': 'Geometry',
    'scanCleanup.pages.diagnostics.recommendedMode': 'Recommended output mode',
    'scanCleanup.pages.diagnostics.recommendedModeValue': '{mode} · {confidence} output-mode confidence',
    'scanCleanup.pages.diagnostics.reason': 'Reason',
    'scanCleanup.pages.diagnostics.modeReason.text-with-pictures': 'Text with picture regions',
    'scanCleanup.pages.diagnostics.layout': 'Layout',
    'scanCleanup.pages.diagnostics.layoutValue': '{layout} · {confidence} layout confidence',
    'scanCleanup.pages.diagnostics.reconciled': 'Reconciled by document-level evidence',
    'scanCleanup.pages.diagnostics.splitAbstained': 'The split detector abstained',
    'scanCleanup.pages.diagnostics.deskew': 'Deskew',
    'scanCleanup.pages.diagnostics.deskewValue': '{angle}° · {confidence}',
    'scanCleanup.pages.diagnostics.deskewManualValue': '{angle}° · manual',
    'scanCleanup.pages.diagnostics.binarization': 'Binarization',
    'scanCleanup.pages.diagnostics.contrastIllumination': 'Contrast / light',
    'scanCleanup.pages.diagnostics.contrastIlluminationValue': '{contrast} / {illumination}',
    'scanCleanup.pages.diagnostics.edgeStroke': 'Edges / stroke',
    'scanCleanup.pages.diagnostics.edgeStrokeValue': '{edge} / {stroke} px',
    'scanCleanup.pages.diagnostics.borderAgreement': 'Dark border / agreement',
    'scanCleanup.pages.diagnostics.borderAgreementValue': '{border} / {agreement}',
    'scanCleanup.pages.diagnostics.despeckleFallback': 'Despeckle fallback',
    'scanCleanup.pages.diagnostics.fallbackUsed': 'Used',
    'scanCleanup.pages.diagnostics.fallbackNotUsed': 'Not used',
    'scanCleanup.pages.diagnostics.dewarp': 'Auto-dewarp',
    'scanCleanup.pages.diagnostics.dewarpApplied': 'Applied · {confidence}',
    'scanCleanup.pages.diagnostics.dewarpGated': 'Not applied by quality gate · {confidence}',
    'scanCleanup.pages.diagnostics.acceptedTrim': 'Accepted trim',
    'scanCleanup.pages.diagnostics.acceptedTrimValue': '{side} · {score} ≥ {threshold}',
    'scanCleanup.pages.diagnostics.removedBounds': 'Removed bounds',
    'scanCleanup.pages.diagnostics.protectedBounds': 'Protected bounds',
    'scanCleanup.pages.diagnostics.trimResult': 'Result',
    'scanCleanup.pages.diagnostics.noTrim': 'No trim accepted',
    'scanCleanup.pages.diagnostics.pictureEvidence': 'picture',
    'scanCleanup.pages.diagnostics.headingEvidence': 'heading',
    'scanCleanup.pages.diagnostics.grayscaleEvidence': 'tonal',
    'scanCleanup.pages.diagnostics.noProtectedEvidence': 'no picture/heading evidence',
    'scanCleanup.pages.diagnostics.boundsValue': '{x}, {y} · {width}×{height} px · {evidence}',
    'scanCleanup.pages.diagnostics.sideConfidence': 'Edge confidence',
    'scanCleanup.pages.diagnostics.sideConfidenceValue': '{side} {confidence}',
    'scanCleanup.pages.diagnostics.trimSide.left': 'Left',
    'scanCleanup.pages.diagnostics.trimSide.top': 'Top',
    'scanCleanup.pages.diagnostics.trimSide.right': 'Right',
    'scanCleanup.pages.diagnostics.trimSide.bottom': 'Bottom',
    'scanCleanup.pages.diagnostics.unavailable': 'Unavailable',
    'scanCleanup.pages.diagnostics.notApplicable': 'Not applicable',
    'scanCleanup.preview.outputHalf.full': 'full page',
    'scanCleanup.preview.outputHalf.left': 'left half',
    'scanCleanup.preview.outputHalf.right': 'right half',
    'scanCleanup.advanced.binarization.otsu': 'Otsu',
    'scanCleanup.output.auto': 'Auto',
    'scanCleanup.output.bw': 'Black and white',
    'scanCleanup.output.bwShort': 'B&W',
    'scanCleanup.output.grayscale': 'Grayscale',
    'scanCleanup.output.grayscaleShort': 'Gray',
    'scanCleanup.output.color': 'Color',
    'scanCleanup.output.colorShort': 'Color',
    'scanCleanup.output.mixed': 'Text + pictures',
    'scanCleanup.output.mixedShort': 'Mixed',
};

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (
        key: string,
        parameters?: Record<string, string | number>,
    ) => Object.entries(parameters ?? {}).reduce(
        (value, [
            parameter,
            replacement,
        ]) => value.replace(`{${parameter}}`, String(replacement)),
        messages[key] ?? key,
    )}),
}));

const ButtonStub = defineComponent({
    inheritAttrs: false,
    props: {
        icon: {
            type: String,
            default: '',
        },
        label: {
            type: String,
            default: '',
        },
    },
    setup: (props, {attrs}) => () => h('button', {
        ...attrs,
        type: 'button',
    }, [
        props.icon ? h('span', {'data-icon': props.icon}) : null,
        props.label,
    ]),
});
const SelectStub = defineComponent({
    inheritAttrs: false,
    props: {
        items: {
            type: Array,
            default: () => [],
        },
        modelValue: {
            type: [
                Number,
                String,
            ],
            default: '',
        },
        portal: {
            type: [
                Boolean,
                String,
            ],
            default: false,
        },
        ui: {
            type: Object,
            default: () => ({}),
        },
    },
    emits: ['update:modelValue'],
    setup(props, {
        attrs,
        emit,
    }) {
        const open = ref(false);
        return () => {
            const items = props.items as Array<{
                label: string;
                value: string
            }>;
            const trigger = h('select', {
                ...attrs,
                value: props.modelValue,
                onClick: () => { open.value = true; },
                onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value),
            }, items.map(item => h('option', {value: item.value}, item.label)));
            if (!open.value || !props.portal) {
                return trigger;
            }
            const ui = props.ui as Record<string, string>;
            const menu = h('div', {
                class: ui.content,
                'data-select-menu-stub': '',
            }, items.map(item => h('span', {
                class: ui.itemLabel,
                'data-select-item-label-stub': '',
            }, item.label)));
            return [
                trigger,
                h(Teleport, {to: typeof props.portal === 'string' ? props.portal : 'body'}, menu),
            ];
        };
    },
});
const BadgeStub = defineComponent({setup: (_props, {slots}) => () => h('span', {'data-ui-badge': ''}, slots.default?.())});
const IconStub = defineComponent({
    inheritAttrs: false,
    props: {name: {
        type: String,
        default: '',
    }},
    setup: (props, {attrs}) => () => h('span', {
        ...attrs,
        'data-icon': props.name,
    }),
});
const TooltipStub = defineComponent({
    inheritAttrs: false,
    props: {
        disabled: Boolean,
        text: {
            type: String,
            default: '',
        },
    },
    setup(props, {
        attrs,
        slots,
    }) {
        const open = ref(false);
        return () => h('span', {
            ...attrs,
            'data-tooltip-root': '',
            onFocusin: () => { open.value = !props.disabled; },
            onFocusout: () => { open.value = false; },
            onPointerenter: () => { open.value = !props.disabled; },
            onPointerleave: () => { open.value = false; },
        }, [
            slots.default?.(),
            open.value && !props.disabled
                ? h(Teleport, {to: 'body'}, h('div', {
                    'data-tooltip-content': '',
                    role: 'tooltip',
                }, props.text))
                : null,
        ]);
    },
});
const PopoverStub = defineComponent({
    props: {open: Boolean},
    emits: ['update:open'],
    setup: (props, {
        emit,
        slots,
    }) => () => h('span', {
        'data-popover-root': '',
        onClick: () => emit('update:open', true),
    }, [
        slots.default?.(),
        props.open
            ? h(Teleport, {to: 'body'}, h('div', {
                'data-popover-content': '',
                role: 'dialog',
            }, slots.content?.()))
            : null,
    ]),
});
const mountedApps = new Set<() => void>();

function createSource(pageCount = 5): IDocumentPageSource {
    const renderPage = vi.fn(async () => ({
        widthPx: 100,
        heightPx: 140,
        bytes: 56_000,
        surface: 'data:image/png;base64,',
        release: vi.fn(),
    }));
    return {
        kind: 'pdf',
        documentRef: requireDocumentRef('/document.pdf'),
        pageCount,
        getPageMetrics: vi.fn(async () => ({
            widthPoints: 500,
            heightPoints: 700,
            rotation: 0 as const,
        })),
        renderPage,
        thumbnailProvider: {renderThumbnail: renderPage},
        dispose: vi.fn(),
    };
}

function mountRail(options: {
    source?: IDocumentPageSource | null;
    sourcePending?: boolean;
    detectionActive?: boolean;
    settledPages?: ReadonlySet<number>;
    classifications?: ReadonlyMap<number, IScanCleanupPreviewMetadata['layoutClassification']>;
    confidences?: ReadonlyMap<number, number>;
    recommendedOutputModes?: ReadonlyMap<number, 'bw' | 'mixed' | 'grayscale' | 'color'>;
    recommendedOutputModeConfidences?: ReadonlyMap<number, number>;
    recommendedOutputModeReasons?: ReadonlyMap<number, 'blank' | 'color-chroma' | 'text-with-pictures'
        | 'continuous-tone' | 'bimodal-text' | 'uncertain-tonal'>;
    diagnostics?: ReadonlyMap<number, IScanCleanupPreviewPageMetadata>;
    documentOutputMode?: 'auto' | 'bw' | 'grayscale' | 'color';
    preserveOriginalQuality?: boolean;
    textAxes?: ReadonlyMap<number, IScanCleanupTextAxis>;
    overrides?: TScanCleanupPageOverrides;
    leader?: number;
    selected?: ReadonlySet<number>;
    processed?: ReadonlySet<number>;
    disabled?: boolean;
} = {}) {
    const source = options.source === undefined ? createSource() : options.source;
    const leader = ref(options.leader ?? 1);
    const anchor = ref(options.leader ?? 1);
    const selected = ref<ReadonlySet<number>>(options.selected ?? new Set([leader.value]));
    const disabled = ref(options.disabled ?? false);
    const overrideUpdates: Array<[number, IScanCleanupPageOverride]> = [];
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(ScanCleanupThumbnailRail, {
        source,
        sourcePending: options.sourcePending ?? false,
        detectionActive: options.detectionActive ?? false,
        settledPages: options.settledPages ?? new Set<number>(),
        totalPages: source?.pageCount ?? 5,
        selectionLeader: leader.value,
        selectedPages: selected.value,
        overrides: options.overrides ?? {},
        classifications: options.classifications ?? new Map(),
        confidences: options.confidences ?? new Map(),
        documentOutputMode: options.documentOutputMode ?? 'auto',
        preserveOriginalQuality: options.preserveOriginalQuality ?? false,
        recommendedOutputModes: options.recommendedOutputModes ?? new Map(),
        recommendedOutputModeConfidences: options.recommendedOutputModeConfidences ?? new Map(),
        recommendedOutputModeReasons: options.recommendedOutputModeReasons ?? new Map(),
        diagnostics: options.diagnostics ?? new Map(),
        textAxes: options.textAxes ?? new Map(),
        processedPages: options.processed ?? new Set(),
        disabled: disabled.value,
        onSelectPage: (page: number, intent: TScanCleanupSelectionIntent, orderedPages: readonly number[]) => {
            const next = resolveScanCleanupSelection({
                anchor: anchor.value,
                leader: leader.value,
                selectedPages: selected.value,
            }, page, intent, orderedPages);
            anchor.value = next.anchor;
            leader.value = next.leader;
            selected.value = next.selectedPages;
        },
        'onUpdate:override': (page: number, value: IScanCleanupPageOverride) => overrideUpdates.push([
            page,
            value,
        ]),
    })}));
    app.component('AppTooltip', AppTooltip);
    app.component('UBadge', BadgeStub);
    app.component('UButton', ButtonStub);
    app.component('UIcon', IconStub);
    app.component('UPopover', PopoverStub);
    app.component('USelect', SelectStub);
    app.component('UTooltip', TooltipStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        mountedApps.delete(unmount);
    };
    mountedApps.add(unmount);
    return {
        host,
        disabled,
        leader,
        overrideUpdates,
        selected,
    };
}

function naturalOrder(host: HTMLElement) {
    return Array.from(host.querySelectorAll<HTMLElement>('.scan-thumbnail-overlay'))
        .map(element => Number(element.dataset.pageNumber));
}

// A row is the overlay plus the label band underneath it, so page-level
// assertions have to start from the row rather than from the overlay.
function pageRow(host: HTMLElement, page: number) {
    return host.querySelector<HTMLElement>(`.scan-thumbnail-overlay[data-page-number="${String(page)}"]`)!.parentElement!;
}

function openOptions(host: HTMLElement, page: number) {
    pageRow(host, page).querySelector<HTMLButtonElement>('.scan-thumbnail-options-toggle')!.click();
    return nextTick();
}

afterEach(() => {
    for (const unmount of mountedApps) unmount();
    document.body.innerHTML = '';
});

describe('ScanCleanupThumbnailRail', () => {
    it('keeps a million-page sorted order bounded to the loaded pages', () => {
        const order = createScanCleanupSparsePageOrder(
            1_000_000,
            new Set([
                2,
                999_999,
            ]),
            (left, right) => left - right,
        );

        expect(order.length).toBe(1_000_000);
        expect(order.pageAt(1)).toBe(2);
        expect(order.pageAt(2)).toBe(999_999);
        expect(order.pageAt(3)).toBe(1);
        expect(order.pageAt(1_000_000)).toBe(1_000_000);
        expect(order.positionOf(999_999)).toBe(2);
        expect(order.positionOf(1_000_000)).toBe(1_000_000);
    });

    it('matches the old full order when every small-document page is loaded', () => {
        const pages = [
            1,
            2,
            3,
            4,
            5,
        ];
        const order = createScanCleanupSparsePageOrder(
            pages.length,
            pages,
            (left, right) => (right % 2) - (left % 2) || left - right,
        );

        expect(pages.map((_, index) => order.pageAt(index + 1))).toEqual([
            1,
            3,
            5,
            2,
            4,
        ]);
        expect(order.positionOf(3)).toBe(2);
        expect(order.positionOf(4)).toBe(5);
    });

    it('gives every row the same two overlay buttons and the same label band', () => {
        const harness = mountRail({
            leader: 2,
            classifications: new Map([[
                1,
                'single-uncut-page',
            ]]),
            overrides: {'3': {
                rotationDegrees: 90,
                layoutOverride: 'auto',
                excluded: true,
                manualSplit: null,
            }},
        });

        // Selection, exclusion and detection state used to add or remove
        // affordances, which slid the remaining buttons out from under the
        // pointer mid-edit.
        for (const page of [
            1,
            2,
            3,
        ]) {
            const row = pageRow(harness.host, page);
            expect(row.querySelectorAll('.scan-thumbnail-actions button')).toHaveLength(2);
            expect(row.querySelector('.scan-thumbnail-options-toggle')).not.toBeNull();
            expect(row.querySelector('.scan-thumbnail-exclude-toggle')).not.toBeNull();
            expect(row.querySelectorAll('.scan-thumbnail-status')).toHaveLength(1);
        }

        const overlay = harness.host.querySelector<HTMLElement>('.scan-thumbnail-overlay')!;
        const labelBand = harness.host.querySelector<HTMLElement>('.scan-thumbnail-label-band')!;
        expect(overlay.contains(labelBand)).toBe(false);
        expect(labelBand.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    });

    it('shows explicit loading and unavailable states instead of a blank rail', async () => {
        const loading = mountRail({
            source: null,
            sourcePending: true,
        });
        expect(loading.host.querySelector('.scan-thumbnail-source-state')?.textContent)
            .toContain('Loading source pages…');
        expect(loading.host.querySelector('.scan-thumbnail-source-state')?.getAttribute('role')).toBe('status');

        loading.host.remove();
        const unavailable = mountRail({
            source: null,
            sourcePending: false,
        });
        await nextTick();
        expect(unavailable.host.querySelector('.scan-thumbnail-source-state')?.textContent)
            .toContain('Source pages are unavailable');
        expect(unavailable.host.querySelector('.scan-thumbnail-source-state')?.textContent)
            .toContain('Reopen Scan Cleanup');
        expect(unavailable.host.querySelector('.scan-thumbnail-source-state')?.getAttribute('role')).toBe('alert');
    });

    it('keeps the rail header limited to source title, count, and sort', () => {
        const overrides: TScanCleanupPageOverrides = {'1': {
            rotationDegrees: 90,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
        }};
        const harness = mountRail({overrides});
        const header = harness.host.querySelector('.scan-thumbnail-rail-header');

        expect(header?.textContent).toContain('Source pages');
        expect(header?.querySelector('.scan-thumbnail-sort')).not.toBeNull();
        expect(header?.querySelectorAll('button')).toHaveLength(0);
    });

    it('removes thumbnail interaction affordances while cleanup is running', async () => {
        const harness = mountRail({overrides: {'2': {
            excluded: false,
            layoutOverride: 'auto',
            manualSplit: null,
            outputModeOverride: 'bw',
            rotationDegrees: 0,
        }}});
        await openOptions(harness.host, 2);
        expect(document.body.querySelector('[data-popover-content]')).not.toBeNull();

        harness.disabled.value = true;
        await nextTick();

        const list = harness.host.querySelector<HTMLElement>('[data-thumbnail-list-stub]')!;
        const row = pageRow(harness.host, 2);

        expect(document.body.querySelector('[data-popover-content]')).toBeNull();
        expect(list.getAttribute('aria-disabled')).toBe('true');
        expect(list.getAttribute('tabindex')).toBe('-1');
        expect(row.classList).toContain('is-disabled');
        expect(row.getAttribute('tabindex')).toBe('-1');
        expect(row.querySelector<HTMLButtonElement>('.scan-thumbnail-options-toggle')?.disabled).toBe(true);

        const exclude = row.querySelector<HTMLButtonElement>('.scan-thumbnail-exclude-toggle')!;
        exclude.dispatchEvent(new PointerEvent('pointerenter', {bubbles: true}));
        await nextTick();
        expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

        row.click();
        list.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'End',
        }));
        await nextTick();

        expect(harness.leader.value).toBe(1);
        expect([...harness.selected.value]).toEqual([1]);
    });

    it('portals the override menu outside the virtual list and renders complete item labels', async () => {
        const harness = mountRail();
        const list = harness.host.querySelector<HTMLElement>('[data-thumbnail-list-stub]')!;
        await openOptions(harness.host, 1);
        const trigger = document.body.querySelector<HTMLSelectElement>('.scan-thumbnail-layout-select')!;

        trigger.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await nextTick();

        const menu = document.body.querySelector<HTMLElement>('.scan-thumbnail-override-menu')!;
        const labels = Array.from(menu.querySelectorAll<HTMLElement>('[data-select-item-label-stub]'));
        expect(menu).not.toBeNull();
        expect(harness.host.contains(menu)).toBe(false);
        expect(list.contains(menu)).toBe(false);
        expect(menu.classList).toContain('w-auto');
        expect(menu.classList).toContain('min-w-(--reka-select-trigger-width)');
        expect(labels.map(label => label.textContent)).toEqual([
            'Auto',
            'Single page',
            'Two-page spread',
            'Keep left half',
            'Keep right half',
        ]);
        expect(labels.every(label => label.classList.contains('whitespace-nowrap'))).toBe(true);
        expect(labels.every(label => !label.classList.contains('truncate'))).toBe(true);

        const renderedMenuWidth = Math.max(...labels.map(label => label.textContent?.length ?? 0));
        Object.defineProperty(menu, 'clientWidth', {
            configurable: true,
            value: renderedMenuWidth,
        });
        for (const label of labels) {
            const labelWidth = label.textContent?.length ?? 0;
            Object.defineProperties(label, {
                clientWidth: {
                    configurable: true,
                    value: renderedMenuWidth,
                },
                scrollWidth: {
                    configurable: true,
                    value: labelWidth,
                },
            });
            expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
        }
    });

    it('streams pending detection indicators into the status line page by page', async () => {
        const classifications = reactive(new Map<number, IScanCleanupPreviewMetadata['layoutClassification']>());
        const harness = mountRail({
            classifications,
            detectionActive: true,
        });

        expect(harness.host.querySelectorAll('.scan-thumbnail-detection-pending')).toHaveLength(5);
        expect(harness.host.querySelector('[aria-label="Detecting page 1"]')).not.toBeNull();
        expect(pageRow(harness.host, 1).querySelector('.scan-thumbnail-status')?.textContent)
            .toContain('Detecting…');

        classifications.set(1, 'two-page-spread');
        await nextTick();
        expect(harness.host.querySelectorAll('.scan-thumbnail-detection-pending')).toHaveLength(4);
        expect(pageRow(harness.host, 1).querySelector('.scan-thumbnail-status')?.textContent).toContain('Spread');
    });

    it('settles a page as soon as the running job reports it, while the rest still spin', async () => {
        const classifications = reactive(new Map<number, IScanCleanupPreviewMetadata['layoutClassification']>());
        const settledPages = reactive(new Set<number>());
        const harness = mountRail({
            classifications,
            detectionActive: true,
            settledPages,
        });

        // Reading the document is the long stage of a large job and reports no
        // classifications at all: every page used to spin for its whole run.
        expect(harness.host.querySelectorAll('.scan-thumbnail-detection-pending')).toHaveLength(5);

        settledPages.add(2);
        settledPages.add(4);
        await nextTick();
        expect(harness.host.querySelectorAll('.scan-thumbnail-detection-pending')).toHaveLength(3);
        expect(harness.host.querySelector('[aria-label="Detecting page 2"]')).toBeNull();
        expect(harness.host.querySelector('[aria-label="Detecting page 1"]')).not.toBeNull();

        classifications.set(2, 'two-page-spread');
        await nextTick();
        expect(harness.host.querySelectorAll('.scan-thumbnail-detection-pending')).toHaveLength(3);
        expect(pageRow(harness.host, 2).querySelector('.scan-thumbnail-status')?.textContent).toContain('Spread');
    });

    it('supports single, Ctrl/Cmd toggle, Shift range, and keyboard leader navigation', async () => {
        const harness = mountRail();
        const row = (page: number) => harness.host.querySelector<HTMLElement>(`.scan-thumbnail-overlay[data-page-number="${String(page)}"]`)?.parentElement;

        row(2)?.click();
        await nextTick();
        expect(harness.leader.value).toBe(2);
        expect([...harness.selected.value]).toEqual([2]);

        row(4)?.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            ctrlKey: true,
        }));
        await nextTick();
        expect(harness.leader.value).toBe(4);
        expect([...harness.selected.value]).toEqual([
            2,
            4,
        ]);

        row(1)?.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            shiftKey: true,
        }));
        await nextTick();
        expect(harness.leader.value).toBe(1);
        expect([...harness.selected.value]).toEqual([
            1,
            2,
            3,
            4,
        ]);

        const list = harness.host.querySelector<HTMLElement>('[data-thumbnail-list-stub]')!;
        list.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'End',
        }));
        await nextTick();
        expect(harness.leader.value).toBe(5);
        expect([...harness.selected.value]).toEqual([5]);
        expect(harness.host.querySelector('[data-position="5"]')?.getAttribute('data-current')).toBe('true');

        list.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'PageUp',
        }));
        await nextTick();
        expect(harness.leader.value).toBe(1);
    });

    it('sorts only rail positions by classification and confidence with unknowns last', async () => {
        const harness = mountRail({
            classifications: reactive(new Map([
                [
                    1,
                    'two-page-spread' as const,
                ],
                [
                    3,
                    'single-uncut-page' as const,
                ],
                [
                    4,
                    'page-with-offcut' as const,
                ],
            ])),
            confidences: reactive(new Map([
                [
                    1,
                    0.8,
                ],
                [
                    3,
                    0.2,
                ],
                [
                    5,
                    0.5,
                ],
            ])),
        });
        const sort = harness.host.querySelector<HTMLSelectElement>('.scan-thumbnail-sort');
        expect(naturalOrder(harness.host)).toEqual([
            1,
            2,
            3,
            4,
            5,
        ]);

        sort!.value = 'classification';
        sort!.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        expect(naturalOrder(harness.host)).toEqual([
            3,
            4,
            1,
            2,
            5,
        ]);

        sort!.value = 'confidence';
        sort!.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        expect(naturalOrder(harness.host)).toEqual([
            3,
            5,
            1,
            2,
            4,
        ]);
    });

    it('summarises layout, output mode, rotation, and exclusion as one status line', () => {
        const harness = mountRail({
            leader: 2,
            selected: new Set([
                2,
                3,
            ]),
            classifications: new Map([[
                2,
                'single-uncut-page',
            ]]),
            processed: new Set([
                1,
                2,
            ]),
            recommendedOutputModes: new Map([[
                2,
                'grayscale',
            ]]),
            overrides: {
                '2': {
                    rotationDegrees: 90,
                    layoutOverride: 'auto',
                    excluded: false,
                    manualSplit: null,
                },
                '3': {
                    rotationDegrees: 0,
                    layoutOverride: 'keep-left',
                    excluded: true,
                    manualSplit: null,
                },
            },
        });
        const page2 = pageRow(harness.host, 2);
        const page3 = pageRow(harness.host, 3);

        expect(page2.querySelector('.scan-thumbnail-status')?.textContent).toBe('Single · Gray · 90°');
        expect(page2.querySelector('[data-icon="i-ph-check-circle"]')).not.toBeNull();
        // An excluded page says only that: the layout and mode it would have
        // been given are irrelevant while it stays out of the output.
        expect(page3.querySelector('.scan-thumbnail-status')?.textContent).toBe('Excluded');
        expect(page3.querySelector('.scan-thumbnail-overlay')?.classList.contains('is-excluded')).toBe(true);
        expect(page3.querySelector('.scan-thumbnail-page-number')?.classList.contains('is-excluded')).toBe(true);
        expect(page3.querySelector('[data-icon="i-ph-check-circle"]')).toBeNull();

        const page3Toggle = page3.querySelector<HTMLButtonElement>('.scan-thumbnail-exclude-toggle')!;
        expect(page3Toggle.getAttribute('role')).toBe('switch');
        expect(page3Toggle.getAttribute('aria-checked')).toBe('false');
        expect(page3Toggle.querySelector('[data-icon="i-ph-eye-slash"]')).not.toBeNull();
        page3Toggle.click();
        expect(harness.overrideUpdates.at(-1)).toEqual([
            3,
            expect.objectContaining({excluded: false}),
        ]);
    });

    it('edits layout, rotation, and output mode from one labelled page popover', async () => {
        const harness = mountRail({
            leader: 1,
            classifications: new Map([[
                2,
                'two-page-spread',
            ]]),
            recommendedOutputModes: new Map([[
                2,
                'bw',
            ]]),
            recommendedOutputModeConfidences: new Map([[
                2,
                0.93,
            ]]),
        });
        const toggle = pageRow(harness.host, 2).querySelector<HTMLButtonElement>('.scan-thumbnail-options-toggle')!;
        expect(toggle.getAttribute('aria-label')).toBe('Page 2 settings');
        expect(toggle.querySelector('[data-icon="i-ph-sliders-horizontal"]')).not.toBeNull();

        await openOptions(harness.host, 2);
        const popover = document.body.querySelector<HTMLElement>('[data-popover-content]')!;
        expect(popover.textContent).toContain('Page 2');
        // The three settings the rail can change now carry their own labels
        // instead of being inferred from a chip's shape or colour.
        expect(popover.textContent).toContain('Page layout');
        expect(popover.textContent).toContain('Rotation');
        expect(popover.textContent).toContain('Output mode');
        expect(popover.textContent).toContain(
            'Recommended output mode: Black and white — 93% output-mode confidence.',
        );
        expect(harness.leader.value).toBe(1);

        const layout = popover.querySelector<HTMLSelectElement>('[aria-label="Layout override for page 2"]')!;
        expect(Array.from(layout.options).map(option => option.textContent)).toEqual([
            'Auto',
            'Single page',
            'Two-page spread',
            'Keep left half',
            'Keep right half',
        ]);
        layout.value = 'single';
        layout.dispatchEvent(new Event('change', {bubbles: true}));
        expect(harness.overrideUpdates.at(-1)).toEqual([
            2,
            expect.objectContaining({layoutOverride: 'single'}),
        ]);

        const rotation = popover.querySelector<HTMLSelectElement>('[aria-label="Rotation for page 2"]')!;
        expect(Array.from(rotation.options).map(option => option.textContent)).toEqual([
            '0°',
            '90°',
            '180°',
            '270°',
        ]);
        rotation.value = '270';
        rotation.dispatchEvent(new Event('change', {bubbles: true}));
        expect(harness.overrideUpdates.at(-1)).toEqual([
            2,
            expect.objectContaining({rotationDegrees: 270}),
        ]);

        const mode = popover.querySelector<HTMLSelectElement>('[aria-label="Output mode for page 2"]')!;
        expect(Array.from(mode.options).map(option => option.textContent)).toEqual([
            'Follow document setting',
            'Black and white',
            'Grayscale',
            'Color',
            'Text + pictures',
        ]);
        mode.value = 'color';
        mode.dispatchEvent(new Event('change', {bubbles: true}));
        expect(harness.overrideUpdates.at(-1)).toEqual([
            2,
            expect.objectContaining({outputModeOverride: 'color'}),
        ]);
    });

    it('marks customized pages and clears a local output override back to the document setting', async () => {
        const harness = mountRail({overrides: {'2': {
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
            outputModeOverride: 'color',
        }}});

        expect(pageRow(harness.host, 2).querySelector('.scan-thumbnail-options-toggle')?.classList)
            .toContain('is-customized');
        expect(pageRow(harness.host, 1).querySelector('.scan-thumbnail-options-toggle')?.classList)
            .not.toContain('is-customized');
        expect(pageRow(harness.host, 2).querySelector('.scan-thumbnail-status')?.textContent).toBe('Color');

        await openOptions(harness.host, 2);
        const select = document.body.querySelector<HTMLSelectElement>('[aria-label="Output mode for page 2"]')!;
        select.value = 'auto';
        select.dispatchEvent(new Event('change', {bubbles: true}));
        expect(harness.overrideUpdates.at(-1)?.[1]).not.toHaveProperty('outputModeOverride');
    });

    it('shows effective fixed and lossless modes in the status line', async () => {
        const fixed = mountRail({
            documentOutputMode: 'bw',
            classifications: new Map([[
                2,
                'single-uncut-page',
            ]]),
            recommendedOutputModes: new Map([[
                2,
                'color',
            ]]),
        });
        expect(pageRow(fixed.host, 2).querySelector('.scan-thumbnail-status')?.textContent)
            .toBe('Single · B&W');
        await openOptions(fixed.host, 2);
        expect(document.body.querySelector('[data-popover-content]')?.textContent)
            .toContain('Effective mode: Black and white — follows the document setting.');

        const lossless = mountRail({
            documentOutputMode: 'bw',
            preserveOriginalQuality: true,
        });
        expect(pageRow(lossless.host, 2).querySelector('.scan-thumbnail-status')?.textContent).toBe('Color');
        await openOptions(lossless.host, 2);
        const losslessPopover = Array.from(document.body.querySelectorAll<HTMLElement>('[data-popover-content]')).at(-1)!;
        expect(losslessPopover.textContent).toContain(
            'Per-page output mode is unavailable because preserving original quality forces color.',
        );
        expect(losslessPopover.querySelector<HTMLSelectElement>(
            '[aria-label="Output mode for page 2"]',
        )?.hasAttribute('disabled')).toBe(true);
    });

    it('keeps an explicit override in the status line while fresh recommendations arrive', async () => {
        const recommendations = reactive(new Map<number, 'bw' | 'mixed' | 'grayscale' | 'color'>());
        const harness = mountRail({
            overrides: {'2': {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                outputModeOverride: 'color',
            }},
            recommendedOutputModes: recommendations,
        });

        expect(pageRow(harness.host, 2).querySelector('.scan-thumbnail-status')?.textContent).toBe('Color');
        expect(pageRow(harness.host, 1).querySelector('.scan-thumbnail-status')?.textContent).toBe('');

        recommendations.set(1, 'bw');
        recommendations.set(2, 'grayscale');
        await nextTick();

        expect(pageRow(harness.host, 1).querySelector('.scan-thumbnail-status')?.textContent).toBe('B&W');
        expect(pageRow(harness.host, 2).querySelector('.scan-thumbnail-status')?.textContent).toBe('Color');
    });

    it('groups rich scan-cleanup diagnostics into mode, trim, and geometry rows', async () => {
        const diagnostics: IScanCleanupPreviewPageMetadata = {
            canvasScope: 'page',
            layoutClassification: 'single-uncut-page',
            layoutConfidence: 0.88,
            cutterXPx: null,
            rotationDegrees: 0,
            excluded: false,
            blankOutputsSkipped: 0,
            tier1Verdict: 'single-uncut-page',
            reconciled: true,
            clusterAgreement: 0.82,
            detectedSkewDegrees: -0.73,
            skewConfidence: 0.91,
            recommendedOutputMode: 'mixed',
            recommendedOutputModeConfidence: 0.94,
            recommendedOutputModeReason: 'text-with-pictures',
            binarizationMode: 'otsu',
            binarizationDiagnostics: {
                route: 'otsu',
                robustContrast: 52.4,
                illuminationDeviation: 7.1,
                edgeDensity: 0.22,
                estimatedStrokeWidthPx: 2.4,
                darkBorderCoverage: 0.03,
                otsuAdaptiveAgreement: 0.89,
            },
            despeckleFallback: false,
            autoDewarpAttempted: true,
            dewarpApplied: true,
            dewarpConfidence: 0.86,
            outputDiagnostics: [{
                half: 'full',
                contentDiagnostics: {
                    sideConfidence: {
                        left: 0.91,
                        top: 0.82,
                        right: 0.74,
                        bottom: 0.68,
                    },
                    textMask: {
                        analysisWidthPx: 800,
                        analysisHeightPx: 1100,
                        inkPixels: 28_000,
                        lineCount: 31,
                    },
                    acceptedTrims: [{
                        side: 'left',
                        iteration: 1,
                        score: 0.83,
                        threshold: 0.71,
                        contentDistanceSum: 22,
                        garbageDistanceSum: 4,
                        removedBlocks: [{
                            bounds: {
                                xPx: 0,
                                yPx: 0,
                                widthPx: 48,
                                heightPx: 1100,
                            },
                            pictureMaskOverlapPixels: 240,
                            headingEvidence: false,
                            grayscaleEvidence: true,
                        }],
                    }],
                    protectedBlocks: [{
                        bounds: {
                            xPx: 64,
                            yPx: 90,
                            widthPx: 320,
                            heightPx: 180,
                        },
                        pictureMaskOverlapPixels: 1_300,
                        headingEvidence: true,
                        grayscaleEvidence: false,
                    }],
                },
            }],
        };
        const diagnosticsByPage = new Map<number, IScanCleanupPreviewPageMetadata>();
        diagnosticsByPage.set(2, diagnostics);
        const harness = mountRail({diagnostics: diagnosticsByPage});

        await openOptions(harness.host, 2);

        const popover = document.body.querySelector<HTMLElement>('.scan-thumbnail-technical')!;
        expect(popover.querySelector('summary')?.textContent).toBe('Technical details');
        expect(popover.textContent).toContain('Mode decision');
        expect(popover.textContent).toContain('Text + pictures · 94% output-mode confidence');
        expect(popover.textContent).toContain('Text with picture regions');
        expect(popover.textContent).toContain('Contrast / light');
        expect(popover.textContent).toContain('Content trim');
        expect(popover.textContent).toContain('Left · 83% ≥ 71%');
        expect(popover.textContent).toContain('48×1100 px · picture, tonal');
        expect(popover.textContent).toContain('Geometry');
        expect(popover.textContent).toContain('-0.73° · 91%');
        expect(popover.textContent).toContain('Edge confidence');
    });

    it('omits diagnostic rows the analysis never produced instead of listing them as unavailable', async () => {
        const harness = mountRail({diagnostics: new Map([[
            2,
            {
                canvasScope: 'page',
                layoutClassification: 'single-uncut-page',
                layoutConfidence: 0.88,
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                tier1Verdict: 'single-uncut-page',
                reconciled: false,
                clusterAgreement: 0.82,
                outputDiagnostics: [],
            } satisfies IScanCleanupPreviewPageMetadata,
        ]])});

        await openOptions(harness.host, 2);
        const technical = document.body.querySelector<HTMLElement>('.scan-thumbnail-technical')!;

        expect(technical.textContent).toContain('Geometry');
        expect(technical.textContent).toContain('Single · 88% layout confidence');
        expect(technical.textContent).not.toContain('Unavailable');
        expect(technical.textContent).not.toContain('Not applicable');
        expect(technical.textContent).not.toContain('Content trim');
        expect(technical.textContent).not.toContain('Deskew');
    });

    it('flags sideways text and low confidence on one marked button that opens the fix', async () => {
        const harness = mountRail({
            leader: 1,
            classifications: new Map([[
                2,
                'two-page-spread',
            ]]),
            confidences: new Map([[
                2,
                0.4,
            ]]),
            recommendedOutputModes: new Map([[
                2,
                'mixed',
            ]]),
            recommendedOutputModeConfidences: new Map([[
                2,
                0.83,
            ]]),
            textAxes: new Map([[
                2,
                {
                    sideways: true,
                    confidence: 0.98,
                },
            ]]),
        });
        const toggle = pageRow(harness.host, 2).querySelector<HTMLButtonElement>('.scan-thumbnail-options-toggle')!;
        expect(toggle.querySelector('[data-icon="i-ph-warning"]')).not.toBeNull();
        expect(pageRow(harness.host, 1).querySelector('.scan-thumbnail-options-toggle [data-icon="i-ph-warning"]'))
            .toBeNull();

        await openOptions(harness.host, 2);
        const notices = Array.from(document.body.querySelectorAll<HTMLElement>('.scan-thumbnail-options-notice'));
        expect(notices.map(notice => notice.textContent?.trim())).toEqual([
            'Detected as "Spread · 40%" with low layout confidence — check this page and set its layout manually if wrong.',
            'Text appears sideways — set rotation (90° or 270°).',
        ]);
        expect(document.body.querySelector<HTMLElement>('.scan-thumbnail-options')?.textContent).toContain(
            'Recommended output mode: Text + pictures — 83% output-mode confidence.',
        );
        expect(harness.leader.value).toBe(1);
    });

    it('drops the sideways-text notice after a non-zero page rotation', () => {
        const harness = mountRail({
            textAxes: new Map([[
                2,
                {
                    sideways: true,
                    confidence: 0.98,
                },
            ]]),
            overrides: {'2': {
                rotationDegrees: 90,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
            }},
        });
        expect(pageRow(harness.host, 2).querySelector('.scan-thumbnail-options-toggle [data-icon="i-ph-warning"]'))
            .toBeNull();
    });

    it('renders the include/exclude hint through AppTooltip on pointer hover and keyboard focus', async () => {
        const harness = mountRail();
        const toggle = pageRow(harness.host, 2).querySelector<HTMLButtonElement>('.scan-thumbnail-exclude-toggle')!;

        toggle.dispatchEvent(new PointerEvent('pointerenter', {bubbles: true}));
        await nextTick();
        expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('Include in output');

        toggle.dispatchEvent(new PointerEvent('pointerleave', {bubbles: true}));
        toggle.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
        await nextTick();
        expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('Include in output');
    });

    it('closes the page popover on Escape without bubbling to workspace handlers', async () => {
        const harness = mountRail();
        const escaped = vi.fn();
        document.addEventListener('keydown', escaped);

        await openOptions(harness.host, 2);
        const popover = document.body.querySelector<HTMLElement>('.scan-thumbnail-options')!;

        popover.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Escape',
        }));
        await nextTick();
        expect(document.body.querySelector('[data-popover-content]')).toBeNull();
        expect(escaped).not.toHaveBeenCalled();
        document.removeEventListener('keydown', escaped);
    });
});
