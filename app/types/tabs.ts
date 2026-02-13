export interface ITab {
    id: string;
    fileName: string | null;
    originalPath: string | null;
    isDirty: boolean;
    isDjvu: boolean;
}

export type TTabUpdate = Partial<Pick<ITab, 'fileName' | 'originalPath' | 'isDirty' | 'isDjvu'>>;
