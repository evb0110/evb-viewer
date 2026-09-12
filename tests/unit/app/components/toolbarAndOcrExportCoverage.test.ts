// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';
import type * as TViMockOriginalModule2 from '@app/constants/shortcuts';
import type * as TViMockOriginalModule3 from '@app/utils/isReaderPrintCommandDisabled';
import type * as TViMockOriginalModule4 from '@app/utils/readerCommandIcons';

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
    reactive,
    ref,
} from 'vue';

const presenterMock = vi.hoisted(() => vi.fn());

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));
vi.mock('@app/composables/useRuntimeEnvironment', () => ({useRuntimeEnvironment: () => ({isBrowserRuntime: ref(true)})}));
vi.mock('@app/constants/shortcuts', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    useShortcutLabels: () => ref({
        exportDocx: '⇧⌘E',
        openFile: '⌘O',
        print: '⌘P',
        save: '⌘S',
        saveAs: '⇧⌘S',
    }),
}));
vi.mock('@app/utils/isReaderPrintCommandDisabled', async (importOriginal_2) => ({
    ...(await importOriginal_2<typeof TViMockOriginalModule3>()),
    isReaderPrintCommandDisabled: () => false,
}));
vi.mock('@app/utils/readerCommandIcons', async (importOriginal_3) => ({
    ...(await importOriginal_3<typeof TViMockOriginalModule4>()),
    getReaderCommandMenuIcon: (command: string) => `icon-${command}`,
    getReaderCommandToolbarIcon: (command: string) => `icon-${command}`,
}));
vi.mock('@app/modules/ocr-panel/runtime/useOcrPopupPresenter', () => ({useOcrPopupPresenter: presenterMock}));
vi.mock('@app/components/icons/PrintCurrentPageIcon.vue', () => ({default: defineComponent({setup: () => () => h('span', {'data-print-icon': ''})})}));

const ButtonStub = defineComponent({
    inheritAttrs: false,
    props: {
        disabled: {
            type: Boolean,
            default: false,
        },
        label: {
            type: String,
            default: '',
        },
    },
    setup(props, {
        attrs,
        slots,
    }) {
        return () => h('button', {
            'data-label': props.label,
            disabled: props.disabled,
            onClick: attrs.onClick,
            type: 'button',
        }, [
            slots.default?.(),
            props.label,
        ]);
    },
});

const SlotStub = defineComponent({
    inheritAttrs: false,
    setup: (_props, {slots}) => () => slots.default?.(),
});

const DropdownMenuStub = defineComponent({
    inheritAttrs: false,
    props: {items: {
        type: Array,
        default: () => [],
    }},
    setup(props, {slots}) {
        return () => h('div', {'data-dropdown': ''}, [
            slots.default?.(),
            ...(props.items as Array<Record<string, unknown>>).map((item, index) => (
                item.type
                    ? h('div', {
                        'data-menu-structural': item.type,
                        key: `structural-${index}`,
                    }, item.label as string ?? '')
                    : h('button', {
                        'data-menu-command': item.label,
                        disabled: item.disabled === true,
                        key: `command-${index}`,
                        onClick: item.onSelect,
                        type: 'button',
                    }, item.label as string ?? '')
            )),
        ]);
    },
});

const ModalStub = defineComponent({
    inheritAttrs: false,
    setup: (_props, {slots}) => () => h('section', {'data-modal': ''}, [
        slots.default?.(),
        slots.description?.(),
        slots.body?.(),
        slots.footer?.(),
    ]),
});

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    presenterMock.mockReset();
});

function mountComponent(component: unknown, props: Record<string, unknown>, register: (app: ReturnType<typeof createApp>) => void) {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(component as never, props)}));
    register(app);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        host,
        unmount,
    };
}

describe('DOCX export component coverage', () => {
    it('keeps the app-menu DOCX command enabled as a cancel command', async () => {
        const {default: ToolbarAppMenu} = await import('@app/components/toolbar/ToolbarAppMenu.vue');
        const state = reactive({
            canExportDocx: false,
            canOptimizePdf: false,
            canPrint: true,
            canRedo: false,
            canRepairSave: false,
            canSave: false,
            canSaveAs: false,
            canUndo: false,
            canUseDjvu: false,
            documentBusy: false,
            hasPdf: true,
            isAnySaving: true,
            isDjvuMode: false,
            isExportingDocx: true,
            isHistoryBusy: true,
            isPreparingCurrentPagePrint: false,
            isPreparingPrint: false,
            open: false,
        });
        const {host} = mountComponent(ToolbarAppMenu, state, app => {
            app.component('UDropdownMenu', DropdownMenuStub);
            app.component('UIcon', SlotStub);
        });

        const command = host.querySelector<HTMLButtonElement>('button[data-menu-command="ocr.cancel"]');
        expect(command).not.toBeNull();
        expect(command?.disabled).toBe(false);
    });

    it('renders a cancel action and locks close while DOCX export is running', async () => {
        const {default: OcrPopup} = await import('@app/modules/ocr-panel/components/OcrPopup.vue');
        const cancelDocxExport = vi.fn();
        presenterMock.mockReturnValue({
            applyingStatusText: ref('ocr.applying'),
            canRunOcr: ref(false),
            cancelOcrForAgent: vi.fn(),
            copyLogsTooltip: ref('ocr.copyLogs'),
            effectiveError: ref(null),
            getAgentOcrSnapshot: vi.fn(),
            handleCancel: vi.fn(),
            handleCancelDocxExport: cancelDocxExport,
            handleCloseResults: vi.fn(),
            handleCopyLogs: vi.fn(),
            handleExportDocx: vi.fn(),
            handleRunOcr: vi.fn(),
            hasLanguageDownloadFailure: ref(false),
            hasResultWarning: ref(false),
            isCopyingLogs: ref(false),
            languagePickerItems: ref([]),
            languageSearchQuery: ref(''),
            pageSegmentationModeSelectValue: ref(''),
            progress: ref({
                isRunning: false,
                status: 'idle',
            }),
            progressPercent: ref(100),
            progressStatusText: ref('ocr.progress'),
            resultStatusText: ref('ocr.done'),
            runOcrForAgent: vi.fn(),
            selectedLanguagesModel: ref([]),
            settings: ref({
                customRange: '',
                pageRange: 'current',
                preprocessingMode: 'off',
                qualityProfile: 'balanced',
                replaceAllAcknowledged: false,
                selectedLanguages: [],
                supersessionPolicy: 'missing-only',
            }),
            showCustomRange: ref(false),
            showLanguageSearch: ref(false),
            showMultipleLanguagesHint: ref(false),
            showSuccessState: ref(true),
            triggerTooltip: ref('ocr.open'),
            viewState: ref('results'),
        });
        const {host} = mountComponent(OcrPopup, {
            currentPage: 1,
            documentRevision: null,
            isExportingDocx: true,
            open: true,
            pdfDocument: null,
            totalPages: 1,
            workingCopyPath: '/tmp/work.pdf',
        }, app => {
            app.component('UModal', ModalStub);
            app.component('AppTooltip', SlotStub);
            app.component('UButton', ButtonStub);
            app.component('UIcon', SlotStub);
            app.component('AppProgressBar', SlotStub);
            app.component('OcrSettingHelpTooltip', SlotStub);
            app.component('AppSearchInput', SlotStub);
            app.component('URadioGroup', SlotStub);
            app.component('UInput', SlotStub);
            app.component('UCheckbox', SlotStub);
            app.component('UCheckboxGroup', SlotStub);
            app.component('UFormField', SlotStub);
            app.component('USelect', SlotStub);
        });
        expect(host.querySelector('button[data-label="ocr.cancel"]')).not.toBeNull();
        const close = host.querySelector<HTMLButtonElement>('button[data-label="common.close"]');
        expect(close?.disabled).toBe(true);
        host.querySelector<HTMLButtonElement>('button[data-label="ocr.cancel"]')?.click();
        expect(cancelDocxExport).toHaveBeenCalledOnce();
    });
});
