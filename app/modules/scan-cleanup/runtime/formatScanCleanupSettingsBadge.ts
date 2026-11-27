import type {TTranslationKey, TTranslateFn} from '@i18n-app';
import type {TScanCleanupNonDefaultSettingKey} from '@app/modules/scan-cleanup/runtime/scanCleanupSettingsBadges';

const settingsBadgeValueKeys: Record<string, TTranslationKey> = {
    auto: 'scanCleanup.advanced.binarization.auto',
    otsu: 'scanCleanup.advanced.binarization.otsu',
    sauvola: 'scanCleanup.advanced.binarization.sauvola',
    wolf: 'scanCleanup.advanced.binarization.wolf',
    off: 'scanCleanup.advanced.despeckle.off',
    cautious: 'scanCleanup.advanced.despeckle.cautious',
    normal: 'scanCleanup.advanced.despeckle.normal',
    aggressive: 'scanCleanup.advanced.despeckle.aggressive',
    bw: 'scanCleanup.output.bw',
    mixed: 'scanCleanup.output.mixed',
    grayscale: 'scanCleanup.output.grayscale',
    color: 'scanCleanup.output.color',
};
const settingsBadgeLayoutValueKeys: Record<string, TTranslationKey> = {
    auto: 'scanCleanup.layout.auto',
    'force-single': 'scanCleanup.layout.single',
    'force-two-page': 'scanCleanup.layout.twoPage',
};
const settingsBadgeAlignmentValueKeys: Record<string, TTranslationKey> = {
    ink: 'scanCleanup.pageSize.ink',
    'top-left': 'scanCleanup.pageSize.topLeft',
    'top-center': 'scanCleanup.pageSize.topCenter',
    'top-right': 'scanCleanup.pageSize.topRight',
    'center-left': 'scanCleanup.pageSize.centerLeft',
    center: 'scanCleanup.pageSize.center',
    'center-right': 'scanCleanup.pageSize.centerRight',
    'bottom-left': 'scanCleanup.pageSize.bottomLeft',
    'bottom-center': 'scanCleanup.pageSize.bottomCenter',
    'bottom-right': 'scanCleanup.pageSize.bottomRight',
};

function translateSettingsBadgeValue(t: TTranslateFn, key: TTranslationKey) {
    return (t as (key: TTranslationKey) => string)(key);
}

export function formatScanCleanupSettingsBadge(t: TTranslateFn, key: TScanCleanupNonDefaultSettingKey, value: string) {
    const booleanValue = value === 'true' || value === 'enabled';
    const enabledLabel = t(`scanCleanup.settingsBadges.values.${booleanValue ? 'enabled' : 'disabled'}`);
    switch (key) {
        case 'preserveOriginalQuality':
            return t('scanCleanup.settingsBadges.items.preserveOriginalQuality', {value: enabledLabel});
        case 'layoutMode':
            return t('scanCleanup.settingsBadges.items.layoutMode', {
                value: translateSettingsBadgeValue(t, settingsBadgeLayoutValueKeys[value] ?? 'scanCleanup.layout.auto'),
            });
        case 'binarization':
            return t('scanCleanup.settingsBadges.items.binarization', {
                value: translateSettingsBadgeValue(t, settingsBadgeValueKeys[value] ?? 'scanCleanup.advanced.binarization.auto'),
            });
        case 'normalizeIllumination':
            return t('scanCleanup.settingsBadges.items.normalizeIllumination', {value: enabledLabel});
        case 'readingOrder':
            return t('scanCleanup.settingsBadges.items.readingOrder', {
                value: t(value === 'rtl' ? 'scanCleanup.layout.rightToLeft' : 'scanCleanup.layout.leftToRight'),
            });
        case 'thickness':
            return t('scanCleanup.settingsBadges.items.thickness', {value});
        case 'crop':
            return t('scanCleanup.settingsBadges.items.crop', {value: enabledLabel});
        case 'matchPageSize':
            return t('scanCleanup.settingsBadges.items.matchPageSize', {value: enabledLabel});
        case 'pageAlignment':
            return t('scanCleanup.settingsBadges.items.pageAlignment', {
                value: translateSettingsBadgeValue(t, settingsBadgeAlignmentValueKeys[value] ?? 'scanCleanup.pageSize.topCenter'),
            });
        case 'marginsMm': {
            try {
                const margins = JSON.parse(value) as Record<string, number>;
                return t('scanCleanup.settingsBadges.items.marginsMm', {
                    left: margins.leftMm ?? 0,
                    top: margins.topMm ?? 0,
                    right: margins.rightMm ?? 0,
                    bottom: margins.bottomMm ?? 0,
                });
            } catch {
                return t('scanCleanup.settingsBadges.items.marginsMm', {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                });
            }
        }
        case 'despeckleLevel':
            return t('scanCleanup.settingsBadges.items.despeckleLevel', {
                value: translateSettingsBadgeValue(t, settingsBadgeValueKeys[value] ?? 'scanCleanup.advanced.despeckle.normal'),
            });
        case 'autoDewarp':
            return t('scanCleanup.settingsBadges.items.autoDewarp', {value: enabledLabel});
        case 'skipBlankPages':
            return t('scanCleanup.settingsBadges.items.skipBlankPages', {value: enabledLabel});
        case 'outputMode':
            return t('scanCleanup.settingsBadges.items.outputMode', {
                value: translateSettingsBadgeValue(t, settingsBadgeValueKeys[value] ?? 'scanCleanup.advanced.binarization.auto'),
            });
        case 'pageOverrides':
            return t('scanCleanup.settingsBadges.items.pageOverrides', {count: Number(value)});
    }
}
