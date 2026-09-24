import type { ITabMetadataCore } from '@contracts/windowTabs';

/** A tab in the pane graph. Its document lives in the tab's document controller. */
export interface ITab {id: string;}

/** What the tab bar shows for one tab. */
export type TTabView = ITab & ITabMetadataCore;
