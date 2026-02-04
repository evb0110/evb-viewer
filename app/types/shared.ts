export interface IRecentFile {
    originalPath: string;
    fileName: string;
    timestamp: number;
    fileSize?: number;
}

export interface IOcrLanguage {
    code: string;
    name: string;
    script: 'latin' | 'cyrillic' | 'greek' | 'rtl';
}

export interface IOcrWord {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export type TFitMode = 'width' | 'height';
