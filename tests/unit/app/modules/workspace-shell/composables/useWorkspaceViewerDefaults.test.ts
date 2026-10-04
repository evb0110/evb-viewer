import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
} from 'vue';
import type { Ref } from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { useWorkspaceViewerDefaults } from '@app/modules/workspace-shell/composables/useWorkspaceViewerDefaults';
import type { TPdfSource } from '@app/types/pdfUi';
import type {
    ISettingsData,
    TFitMode,
    TZoomMode,
} from '@contracts/shared';
import {
    DEFAULT_SETTINGS,
    sanitizeSettings,
} from '@contracts/settings';

function createDefaultsSetup(
    settings: Partial<ISettingsData> = {},
    options: {
        initialDocumentSourceKey?: unknown;
        preserveInitialStateForFirstSource?: boolean;
    } = {},
) {
    const scope = effectScope();
    const appSettings = ref<ISettingsData>(sanitizeSettings({
        ...DEFAULT_SETTINGS,
        ...settings,
    }));
    const annotationSettings = ref({
        ...DEFAULT_ANNOTATION_SETTINGS,
        highlightColor: '#111111',
        underlineColor: '#222222',
        strikethroughColor: '#333333',
        squigglyColor: '#444444',
        inkColor: '#555555',
        shapeColor: '#666666',
    });
    const viewMode = ref<ISettingsData['defaultViewMode']>('facing');
    const continuousScroll = ref(false);
    const fitMode = ref<TFitMode>('height');
    const zoom = ref(2);
    const effectiveZoom = ref(2);
    const zoomMode = ref<TZoomMode>('custom');
    const pdfSrc = ref<TPdfSource | null>(null);
    const documentSourceKey = ref<unknown>(options.initialDocumentSourceKey ?? null);

    const defaults = scope.run(() => useWorkspaceViewerDefaults({
        appSettings,
        annotationSettings,
        viewMode,
        continuousScroll,
        fitMode,
        zoom,
        effectiveZoom,
        zoomMode,
        pdfSrc,
        documentSourceKey,
        preserveInitialStateForFirstSource: options.preserveInitialStateForFirstSource,
    }));

    if (!defaults) {
        throw new Error('Failed to create workspace viewer defaults');
    }

    return {
        appSettings,
        annotationSettings,
        viewMode,
        continuousScroll,
        fitMode,
        zoom,
        effectiveZoom,
        zoomMode,
        pdfSrc,
        documentSourceKey,
        defaults,
        stop: () => scope.stop(),
    };
}

async function openPdf(pdfSrc: Ref<TPdfSource | null>) {
    pdfSrc.value = new Blob([], { type: 'application/pdf' });
    await nextTick();
}

describe('useWorkspaceViewerDefaults', () => {
    it('prepares the configured view before a synchronous open starts from an empty workspace', () => {
        const setup = createDefaultsSetup({
            defaultZoomPreset: 'fit-width',
            defaultViewMode: 'single',
            defaultContinuousScroll: true,
        });

        try {
            expect(setup.documentSourceKey.value).toBeNull();
            expect(setup.fitMode.value).toBe('width');
            expect(setup.zoom.value).toBe(1);
            expect(setup.effectiveZoom.value).toBe(1);
            expect(setup.zoomMode.value).toBe('fit-width');
            expect(setup.viewMode.value).toBe('single');
            expect(setup.continuousScroll.value).toBe(true);
        } finally {
            setup.stop();
        }
    });

    it('prepares a numeric zoom preset before a synchronous open starts', () => {
        const setup = createDefaultsSetup({defaultZoomPreset: '150'});

        try {
            expect(setup.documentSourceKey.value).toBeNull();
            expect(setup.zoom.value).toBe(1.5);
            expect(setup.effectiveZoom.value).toBe(1.5);
            expect(setup.zoomMode.value).toBe('custom');
        } finally {
            setup.stop();
        }
    });

    it('keeps a view seeded for its admitted source when that source is shown, and defaults any other', async () => {
        const setup = createDefaultsSetup(
            {defaultZoomPreset: 'fit-width'},
            {initialDocumentSourceKey: '/tmp/previous-working.pdf'},
        );
        const seed = (source: string) => setup.defaults.seedViewForSource({
            zoom: 1.85,
            zoomMode: 'custom',
            viewMode: 'single',
            continuousScroll: true,
            viewRotation: 0,
        }, source);

        try {
            // A replacing open: seeded, the old source reset, the admitted one shown.
            seed('/tmp/remembered-working.pdf');
            setup.documentSourceKey.value = null;
            await nextTick();
            setup.documentSourceKey.value = '/tmp/remembered-working.pdf';
            await nextTick();
            expect([
                setup.zoomMode.value,
                setup.zoom.value,
                setup.viewMode.value,
            ]).toEqual([
                'custom',
                1.85,
                'single',
            ]);

            // An open seeded for one source that shows another takes that one's defaults.
            seed('/tmp/seeded-working.pdf');
            setup.documentSourceKey.value = '/tmp/unrelated-working.pdf';
            await nextTick();
            expect(setup.zoomMode.value).toBe('fit-width');
        } finally {
            setup.stop();
        }
    });

    it('defaults a source reopened after the open that seeded it ended without showing it', async () => {
        const setup = createDefaultsSetup({defaultZoomPreset: 'fit-width'});

        try {
            const view = {
                zoom: 1.85,
                zoomMode: 'custom' as const,
                viewMode: 'single' as const,
                continuousScroll: true,
                viewRotation: 0 as const,
            };
            // An older open ending does not withdraw a newer open's seed.
            const withdrawOlder = setup.defaults.seedViewForSource(view, '/docs/older.djvu');
            const withdrawNewer = setup.defaults.seedViewForSource(view, '/docs/book.djvu');
            withdrawOlder();
            setup.documentSourceKey.value = '/docs/book.djvu';
            await nextTick();
            expect(setup.zoom.value).toBe(1.85);

            // The open failed or was cancelled: the same source reopened
            // later, unseeded, takes its defaults.
            withdrawNewer();
            setup.documentSourceKey.value = null;
            await nextTick();
            setup.defaults.seedViewForSource(view, '/docs/book.djvu')();
            setup.documentSourceKey.value = '/docs/book.djvu';
            await nextTick();
            expect(setup.zoomMode.value).toBe('fit-width');
        } finally {
            setup.stop();
        }
    });

    it('preserves a document source already attached during setup', async () => {
        const setup = createDefaultsSetup(
            {defaultZoomPreset: 'fit-width'},
            {initialDocumentSourceKey: 'pdf:/docs/transferred.pdf'},
        );

        try {
            expect(setup.fitMode.value).toBe('height');
            expect(setup.zoom.value).toBe(2);
            expect(setup.effectiveZoom.value).toBe(2);
            expect(setup.zoomMode.value).toBe('custom');

            setup.documentSourceKey.value = 'pdf:/docs/replacement.pdf';
            await nextTick();

            expect(setup.fitMode.value).toBe('width');
            expect(setup.zoom.value).toBe(1);
            expect(setup.effectiveZoom.value).toBe(1);
            expect(setup.zoomMode.value).toBe('fit-width');
        } finally {
            setup.stop();
        }
    });

    it('applies fit-width as the sanitized default zoom preset', async () => {
        const setup = createDefaultsSetup({
            defaultZoomPreset: 'fit-width',
            defaultAnnotationColor: '#123456',
            defaultViewMode: 'single',
            defaultContinuousScroll: true,
        });

        try {
            await openPdf(setup.pdfSrc);

            expect(setup.fitMode.value).toBe('width');
            expect(setup.zoom.value).toBe(1);
            expect(setup.effectiveZoom.value).toBe(1);
            expect(setup.zoomMode.value).toBe('fit-width');
            expect(setup.viewMode.value).toBe('single');
            expect(setup.continuousScroll.value).toBe(true);
            expect(setup.annotationSettings.value).toMatchObject({
                highlightColor: '#123456',
                underlineColor: '#123456',
                strikethroughColor: '#123456',
                squigglyColor: '#123456',
                inkColor: '#123456',
                shapeColor: '#123456',
            });
        } finally {
            setup.stop();
        }
    });

    it('applies fit-height as the default zoom preset', async () => {
        const setup = createDefaultsSetup({ defaultZoomPreset: 'fit-height' });

        try {
            await openPdf(setup.pdfSrc);

            expect(setup.fitMode.value).toBe('height');
            expect(setup.zoom.value).toBe(1);
            expect(setup.effectiveZoom.value).toBe(1);
            expect(setup.zoomMode.value).toBe('fit-height');
        } finally {
            setup.stop();
        }
    });

    it.each([
        [
            '100',
            1,
        ],
        [
            '125',
            1.25,
        ],
        [
            '150',
            1.5,
        ],
    ] as const)('applies numeric default zoom preset %s as custom zoom', async (preset, expectedZoom) => {
        const setup = createDefaultsSetup({ defaultZoomPreset: preset });

        try {
            await openPdf(setup.pdfSrc);

            expect(setup.zoom.value).toBe(expectedZoom);
            expect(setup.effectiveZoom.value).toBe(expectedZoom);
            expect(setup.zoomMode.value).toBe('custom');
        } finally {
            setup.stop();
        }
    });

    it('applies fit-width when settings sanitization rejects the stored preset', async () => {
        const setup = createDefaultsSetup({ defaultZoomPreset: 'unsupported' as ISettingsData['defaultZoomPreset'] });

        try {
            await openPdf(setup.pdfSrc);

            expect(setup.appSettings.value.defaultZoomPreset).toBe(DEFAULT_SETTINGS.defaultZoomPreset);
            expect(setup.fitMode.value).toBe('width');
            expect(setup.zoomMode.value).toBe('fit-width');
        } finally {
            setup.stop();
        }
    });

    it('applies viewer defaults when a non-PDF document source opens', async () => {
        const setup = createDefaultsSetup({
            defaultZoomPreset: '125',
            defaultViewMode: 'facing',
            defaultContinuousScroll: true,
        });

        try {
            setup.documentSourceKey.value = 'djvu:/docs/scan.djvu';
            await nextTick();

            expect(setup.viewMode.value).toBe('facing');
            expect(setup.continuousScroll.value).toBe(true);
            expect(setup.zoom.value).toBe(1.25);
            expect(setup.effectiveZoom.value).toBe(1.25);
            expect(setup.zoomMode.value).toBe('custom');
        } finally {
            setup.stop();
        }
    });

    it('restores configured defaults when a document source closes', async () => {
        const setup = createDefaultsSetup({
            defaultZoomPreset: '125',
            defaultViewMode: 'single',
            defaultContinuousScroll: true,
        });

        try {
            await openPdf(setup.pdfSrc);
            setup.zoom.value = 1.44;
            setup.effectiveZoom.value = 1.44;
            setup.zoomMode.value = 'fit-height';
            setup.viewMode.value = 'facing';
            setup.continuousScroll.value = false;

            setup.pdfSrc.value = null;
            await nextTick();

            expect(setup.zoom.value).toBe(1.25);
            expect(setup.effectiveZoom.value).toBe(1.25);
            expect(setup.zoomMode.value).toBe('custom');
            expect(setup.viewMode.value).toBe('single');
            expect(setup.continuousScroll.value).toBe(true);
        } finally {
            setup.stop();
        }
    });

    it('restores defaults when one document identity replaces another without an empty state', async () => {
        const setup = createDefaultsSetup({
            defaultZoomPreset: '125',
            defaultViewMode: 'single',
            defaultContinuousScroll: true,
        });

        try {
            setup.documentSourceKey.value = 'pdf:/docs/a.pdf';
            await nextTick();
            setup.zoom.value = 5.33;
            setup.effectiveZoom.value = 5.33;
            setup.zoomMode.value = 'custom';
            setup.viewMode.value = 'facing';
            setup.continuousScroll.value = false;

            setup.documentSourceKey.value = 'djvu:/docs/b.djvu';
            await nextTick();

            expect(setup.zoom.value).toBe(1.25);
            expect(setup.effectiveZoom.value).toBe(1.25);
            expect(setup.zoomMode.value).toBe('custom');
            expect(setup.viewMode.value).toBe('single');
            expect(setup.continuousScroll.value).toBe(true);
        } finally {
            setup.stop();
        }
    });

    it('preserves viewer state across a source refresh for the same document identity', async () => {
        const setup = createDefaultsSetup({defaultZoomPreset: '125'});

        try {
            setup.documentSourceKey.value = 'pdf:/docs/a.pdf';
            await nextTick();
            setup.zoom.value = 1.44;
            setup.effectiveZoom.value = 1.44;
            setup.pdfSrc.value = new Blob(['refreshed'], {type: 'application/pdf'});
            await nextTick();

            expect(setup.zoom.value).toBe(1.44);
            expect(setup.effectiveZoom.value).toBe(1.44);
        } finally {
            setup.stop();
        }
    });

    it('preserves restored viewer state when the first source is reacquired', async () => {
        const setup = createDefaultsSetup(
            {defaultZoomPreset: 'fit-width'},
            {preserveInitialStateForFirstSource: true},
        );

        try {
            expect(setup.viewMode.value).toBe('facing');
            expect(setup.continuousScroll.value).toBe(false);
            expect(setup.fitMode.value).toBe('height');
            expect(setup.zoom.value).toBe(2);
            expect(setup.effectiveZoom.value).toBe(2);
            expect(setup.zoomMode.value).toBe('custom');

            setup.documentSourceKey.value = 'djvu:/docs/restored.djvu';
            await nextTick();

            expect(setup.viewMode.value).toBe('facing');
            expect(setup.continuousScroll.value).toBe(false);
            expect(setup.fitMode.value).toBe('height');
            expect(setup.zoom.value).toBe(2);
            expect(setup.effectiveZoom.value).toBe(2);
            expect(setup.zoomMode.value).toBe('custom');

            setup.documentSourceKey.value = 'pdf:/docs/replacement.pdf';
            await nextTick();

            expect(setup.zoom.value).toBe(1);
            expect(setup.effectiveZoom.value).toBe(1);
            expect(setup.zoomMode.value).toBe('fit-width');
        } finally {
            setup.stop();
        }
    });
});
