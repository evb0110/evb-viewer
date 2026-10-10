use super::*;

pub(crate) struct Input<'a> {
    pub analysis_normalized: &'a GrayImage,
    pub analysis_scale_x: f64,
    pub analysis_scale_y: f64,
    pub analysis_picture_mask: Option<&'a BinaryImage>,
    pub faint_stroke_masks: [Option<&'a BinaryImage>; 2],
    pub tone_picture_mask: Option<&'a BinaryImage>,
    pub text_mask: Option<&'a BinaryImage>,
    pub text_vicinity_mask: Option<&'a BinaryImage>,
    pub options: &'a CleanupOptions,
    pub half: PageHalf,
    pub region: Rect,
    pub working_width: usize,
    pub working_height: usize,
}

pub(crate) struct Output {
    pub analysis_working: GrayImage,
    pub analysis_picture_working: Option<BinaryImage>,
    pub manual_picture_crop_authority: Option<BinaryImage>,
    pub faint_stroke_masks: [Option<BinaryImage>; 2],
    pub text_tone_diagnostics: Option<TextToneDiagnostics>,
    pub local_scale_x: f64,
    pub local_scale_y: f64,
}

pub(crate) fn prepare(input: Input<'_>) -> Output {
    let analysis_region = Rect::new(
        input.region.x * input.analysis_scale_x,
        input.region.y * input.analysis_scale_y,
        input.region.width * input.analysis_scale_x,
        input.region.height * input.analysis_scale_y,
    );
    let analysis_working = crop_gray(input.analysis_normalized, analysis_region);
    let analysis_picture_working = input
        .analysis_picture_mask
        .map(|mask| crop_binary(mask, analysis_region));
    let manual_picture_crop_authority = manual_picture_crop_authority(
        input.options,
        input.analysis_normalized.width(),
        input.analysis_normalized.height(),
    )
    .map(|mask| crop_binary(&mask, analysis_region));
    let text_tone_diagnostics = if matches!(
        input.options.output_mode,
        OutputMode::Grayscale | OutputMode::Mixed
    ) {
        if let Some(diagnostics) = input
            .options
            .resolved_text_tone_diagnostics
            .for_half(input.half)
        {
            Some(diagnostics)
        } else {
            let tone_picture_working = input
                .tone_picture_mask
                .map(|mask| crop_binary(mask, analysis_region));
            let text_working = input
                .text_mask
                .map(|mask| crop_binary(mask, analysis_region));
            let text_vicinity_working = input
                .text_vicinity_mask
                .map(|mask| crop_binary(mask, analysis_region));
            text_working
                .as_ref()
                .zip(text_vicinity_working.as_ref())
                .map(|(text_mask, text_vicinity_mask)| {
                    let empty_picture_mask;
                    let picture_mask = if let Some(mask) = tone_picture_working.as_ref() {
                        mask
                    } else {
                        empty_picture_mask =
                            BinaryImage::new(analysis_working.width(), analysis_working.height());
                        &empty_picture_mask
                    };
                    derive_text_tone_diagnostics(
                        &analysis_working,
                        text_mask,
                        text_vicinity_mask,
                        picture_mask,
                    )
                })
        }
    } else {
        None
    };
    Output {
        local_scale_x: analysis_working.width() as f64 / input.working_width.max(1) as f64,
        local_scale_y: analysis_working.height() as f64 / input.working_height.max(1) as f64,
        analysis_working,
        analysis_picture_working,
        manual_picture_crop_authority,
        faint_stroke_masks: input
            .faint_stroke_masks
            .map(|mask| mask.map(|mask| crop_binary(mask, analysis_region))),
        text_tone_diagnostics,
    }
}

#[cfg(test)]
#[path = "region_preparation_tests.rs"]
mod tests;
