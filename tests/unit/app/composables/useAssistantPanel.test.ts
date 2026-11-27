// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    ref,
    type Ref,
} from 'vue';
import {
    provideAssistantPanel,
    useAssistantPanel,
} from '@app/composables/useAssistantPanel';
import { installNuxtStateTestStubs } from '@tests/unit/app/composables/installNuxtStateTestStubs';

const cookieStore = new Map<string, Ref<unknown>>();
const stateStore = new Map<string, Ref<unknown>>();

describe('useAssistantPanel', () => {
    beforeEach(() => {
        cookieStore.clear();
        stateStore.clear();
        installNuxtStateTestStubs(cookieStore, stateStore);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('shares live shell inputs from provideAssistantPanel to descendant consumers', () => {
        const isEnabled = ref(true);
        const hasActiveDocument = ref(false);
        let consumer!: ReturnType<typeof useAssistantPanel>;

        const Consumer = defineComponent({
            setup() {
                consumer = useAssistantPanel();
                return () => null;
            },
        });
        const Root = defineComponent({
            setup() {
                provideAssistantPanel({
                    isEnabled,
                    hasActiveDocument,
                });
                return () => h(Consumer);
            },
        });

        const host = document.createElement('div');
        const app = createApp(Root);
        app.mount(host);
        try {
            expect(consumer.isEnabled.value).toBe(true);
            expect(consumer.isAvailable.value).toBe(false);
            consumer.open();
            expect(consumer.isOpen.value).toBe(false);

            hasActiveDocument.value = true;
            expect(consumer.isAvailable.value).toBe(true);
            consumer.toggle();
            expect(consumer.isOpen.value).toBe(true);

            consumer.toggle();
            expect(consumer.isOpen.value).toBe(false);
        } finally {
            app.unmount();
        }
    });

    it('stays safely disabled when no provider is mounted', () => {
        let consumer!: ReturnType<typeof useAssistantPanel>;
        const Standalone = defineComponent({
            setup() {
                consumer = useAssistantPanel();
                return () => null;
            },
        });

        const host = document.createElement('div');
        const app = createApp(Standalone);
        app.mount(host);
        try {
            expect(consumer.isEnabled.value).toBe(false);
            expect(consumer.isAvailable.value).toBe(false);
            consumer.open();
            expect(consumer.isOpen.value).toBe(false);
        } finally {
            app.unmount();
        }
    });
});
