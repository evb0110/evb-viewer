import { ref } from 'vue';

export interface IStampPreset {
    id: string;
    label: string;
    text: string;
    color: string;
    bgColor: string;
}

const STAMP_PRESETS: IStampPreset[] = [
    {
        id: 'approved',
        label: 'Approved',
        text: 'APPROVED',
        color: '#16a34a',
        bgColor: '#dcfce7', 
    },
    {
        id: 'draft',
        label: 'Draft',
        text: 'DRAFT',
        color: '#6b7280',
        bgColor: '#f3f4f6', 
    },
    {
        id: 'rejected',
        label: 'Rejected',
        text: 'REJECTED',
        color: '#dc2626',
        bgColor: '#fef2f2', 
    },
    {
        id: 'confidential',
        label: 'Confidential',
        text: 'CONFIDENTIAL',
        color: '#9333ea',
        bgColor: '#faf5ff', 
    },
    {
        id: 'final',
        label: 'Final',
        text: 'FINAL',
        color: '#2563eb',
        bgColor: '#eff6ff', 
    },
    {
        id: 'for-comment',
        label: 'For Comment',
        text: 'FOR COMMENT',
        color: '#d97706',
        bgColor: '#fffbeb', 
    },
];

const imageCache = new Map<string, Blob>();

function renderStampSvg(preset: IStampPreset): string {
    const textLen = preset.text.length;
    const width = Math.max(200, textLen * 20 + 40);
    const height = 60;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <rect x="2" y="2" width="${width - 4}" height="${height - 4}" rx="6" ry="6"
              fill="${preset.bgColor}" stroke="${preset.color}" stroke-width="3"/>
        <text x="${width / 2}" y="${height / 2 + 1}" text-anchor="middle" dominant-baseline="central"
              font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="bold"
              fill="${preset.color}" letter-spacing="2">${preset.text}</text>
    </svg>`;
}

async function svgToBlob(svg: string): Promise<Blob> {
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const scale = 2;
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                URL.revokeObjectURL(url);
                reject(new Error('Canvas context unavailable'));
                return;
            }
            ctx.scale(scale, scale);
            ctx.drawImage(img, 0, 0);
            URL.revokeObjectURL(url);
            canvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('Failed to create blob'));
                }
            }, 'image/png');
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Failed to load stamp SVG'));
        };
        img.src = url;
    });
}

export const useStampPresets = () => {
    const selectedPresetId = ref(STAMP_PRESETS[0]?.id ?? '');

    async function getStampImage(presetId: string): Promise<Blob | null> {
        const cached = imageCache.get(presetId);
        if (cached) {
            return cached;
        }

        const preset = STAMP_PRESETS.find(p => p.id === presetId);
        if (!preset) {
            return null;
        }

        const svg = renderStampSvg(preset);
        const blob = await svgToBlob(svg);
        imageCache.set(presetId, blob);
        return blob;
    }

    function getPresets() {
        return STAMP_PRESETS;
    }

    function getPresetById(id: string) {
        return STAMP_PRESETS.find(p => p.id === id) ?? null;
    }

    return {
        presets: STAMP_PRESETS,
        selectedPresetId,
        getStampImage,
        getPresets,
        getPresetById,
    };
};
