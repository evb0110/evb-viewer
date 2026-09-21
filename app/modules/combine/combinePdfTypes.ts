export type TCombineFileKind = 'pdf' | 'djvu' | 'image' | 'document';

export interface ICombineFile {
    id: string;
    file: File;
    name: string;
    size: number;
    kind: TCombineFileKind;
}
