// fallow-ignore-file unused-file -- bundled by viewerInvariants.test.ts for Chromium.

import { buildViewerBugReport } from '@app/modules/viewer-invariants/buildViewerBugReport';
import {
    checkViewerInvariants,
    resetViewerInvariantMemory,
} from '@app/modules/viewer-invariants/checkViewerInvariants';
import {
    disposeViewerActionLog,
    installViewerActionLog,
    readViewerUserActions,
} from '@app/modules/viewer-invariants/viewerActionLog';
import { notifyRendererDiagnosticNotice } from '@app/utils/rendererDiagnosticNotices';

Reflect.set(globalThis, '__evbBuildViewerBugReport', buildViewerBugReport);
Reflect.set(globalThis, '__evbCheckViewerInvariants', checkViewerInvariants);
Reflect.set(globalThis, '__evbDisposeViewerActionLog', disposeViewerActionLog);
Reflect.set(globalThis, '__evbInstallViewerActionLog', installViewerActionLog);
Reflect.set(globalThis, '__evbReadViewerUserActions', readViewerUserActions);
Reflect.set(globalThis, '__evbResetViewerInvariantMemory', resetViewerInvariantMemory);
Reflect.set(globalThis, '__evbNotifyRendererDiagnosticNotice', notifyRendererDiagnosticNotice);
