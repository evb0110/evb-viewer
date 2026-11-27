export type TEvbAutomationEventType = 'document-opened' | 'first-page-rendered' | 'navigation-idle' | 'save-committed';

export interface IEvbAutomationEvent<TDetail extends Record<string, unknown> = Record<string, unknown>> {
    detail: TDetail;
    id: number;
    timestamp: number;
    type: TEvbAutomationEventType;
}

export type TEvbAutomationEventPredicate = (event: IEvbAutomationEvent) => boolean;

export type TEvbAutomationEventListener = (event: IEvbAutomationEvent) => void;
