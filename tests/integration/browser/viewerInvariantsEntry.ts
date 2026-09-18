// fallow-ignore-file unused-file -- bundled by viewerInvariants.test.ts for Chromium.

import {
    checkViewerInvariants,
    resetViewerInvariantMemory,
} from '@app/modules/viewer-invariants/checkViewerInvariants';
import { notifyRendererDiagnosticNotice } from '@app/utils/rendererDiagnosticNotices';

Reflect.set(globalThis, '__evbCheckViewerInvariants', checkViewerInvariants);
Reflect.set(globalThis, '__evbResetViewerInvariantMemory', resetViewerInvariantMemory);
Reflect.set(globalThis, '__evbNotifyRendererDiagnosticNotice', notifyRendererDiagnosticNotice);
