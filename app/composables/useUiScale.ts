import type {
    IHostEnvironmentSnapshot,
    THostPlatform,
} from '@contracts/hostPlatformFeature';
import type {
    ISettingsData,
    TUiScalePreference,
} from '@contracts/shared';
import { clamp } from 'es-toolkit/math';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getHostCapability } from '@app/utils/getHostCapability';
import { getRawElectronPlatformApi } from '@app/utils/electronPlatformBridge';

const FALLBACK_PLATFORM: THostPlatform = typeof process !== 'undefined' && process.platform === 'darwin'
    ? 'darwin'
    : 'linux';

const DEFAULT_HOST_SNAPSHOT: IHostEnvironmentSnapshot = {
    platform: FALLBACK_PLATFORM,
    osScaleFactor: 1,
};
const PRESET_SCALE_FACTORS: Record<Exclude<TUiScalePreference, 'auto'>, number> = {
    compact: 0.9,
    default: 1,
    comfortable: 1.1,
    large: 1.25,
};
const WINDOWS_AUTO_COMPENSATION_T = 0.4;
const MIN_AUTO_SCALE = 0.85;
const MAX_AUTO_SCALE = 1;

function lerp(start: number, end: number, t: number) {
    return start + (end - start) * t;
}

function resolveAutoScale(snapshot: IHostEnvironmentSnapshot) {
    if (snapshot.platform !== 'win32') {
        return 1;
    }
    if (!Number.isFinite(snapshot.osScaleFactor) || snapshot.osScaleFactor <= 1) {
        return 1;
    }
    const compensated = lerp(1, 1 / snapshot.osScaleFactor, WINDOWS_AUTO_COMPENSATION_T);
    return clamp(compensated, MIN_AUTO_SCALE, MAX_AUTO_SCALE);
}

function resolveEffectiveUiScale(
    preference: TUiScalePreference,
    snapshot: IHostEnvironmentSnapshot,
) {
    if (preference === 'auto') {
        return resolveAutoScale(snapshot);
    }
    return PRESET_SCALE_FACTORS[preference];
}

function applyUiScaleToDocument(scale: number, snapshot: IHostEnvironmentSnapshot) {
    if (typeof document === 'undefined') {
        return;
    }
    const root = document.documentElement;
    root.style.setProperty('--app-ui-scale', String(scale));
    root.dataset.platform = snapshot.platform;
}

export const useUiScale = () => {
    // Main passes the desktop host to the window at creation, so the first
    // layout already uses the final scale; `getEnvironment` and the change
    // event correct it later.
    const hostSnapshot = useState<IHostEnvironmentSnapshot>(
        'host:environment',
        () => getRawElectronPlatformApi()?.startupHostEnvironment ?? DEFAULT_HOST_SNAPSHOT,
    );

    const preference = useState<TUiScalePreference>(
        'ui-scale:preference',
        () => 'auto',
    );

    const effectiveScale = computed(() =>
        resolveEffectiveUiScale(preference.value, hostSnapshot.value),
    );

    function setPreferenceFromSettings(settings: Pick<ISettingsData, 'uiScale'>) {
        preference.value = settings.uiScale;
    }

    function setHostSnapshot(snapshot: IHostEnvironmentSnapshot) {
        hostSnapshot.value = snapshot;
    }

    async function refreshHostSnapshot() {
        try {
            const next = await getHostCapability().getEnvironment();
            setHostSnapshot(next);
        } catch (error) {
            BrowserLogger.warn('ui-scale', 'Failed to load host environment snapshot', error);
        }
    }

    function attachHostEnvironmentListener() {
        return getHostCapability().onEnvironmentChange((snapshot) => {
            setHostSnapshot(snapshot);
        });
    }

    return {
        hostSnapshot,
        preference,
        effectiveScale,
        setPreferenceFromSettings,
        setHostSnapshot,
        refreshHostSnapshot,
        attachHostEnvironmentListener,
        applyUiScaleToDocument,
    };
};
