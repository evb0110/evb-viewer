import type {IOcrCapability} from '@contracts/ocrPlatformFeature';
import {getPlatformAPI} from '@app/utils/platform';

export function getOcrCapability(): IOcrCapability {
    return getPlatformAPI().ocr;
}
