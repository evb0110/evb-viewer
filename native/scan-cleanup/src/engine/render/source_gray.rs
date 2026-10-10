//! The scan's own gray tone in output space, for the cuts that read it.

use super::*;

/// Renders `source` into output space with the scan's paper beyond it. The
/// renderer fills output past the scan with white; beside a shaded scan edge
/// a local cut reads that white as paper and inks the shading.
pub(super) fn render_source_gray(
    source: &GrayImage,
    render_plan: &ComposedRenderPlan,
    width: usize,
    height: usize,
) -> GrayImage {
    let render = |image: &GrayImage| {
        if render_plan.has_dewarp() {
            rasterize_inverse_area_with(image, width, height, |point| {
                render_plan.output_to_source(point)
            })
        } else {
            render_affine_gray(
                image,
                width,
                height,
                render_plan
                    .affine_inverse()
                    .expect("cleanup affine render plan is available"),
            )
        }
    };
    let mut gray = render(source);
    // White wherever the output lies past the scan, in proportion.
    let beyond = render(&GrayImage::new(source.width(), source.height(), 0));
    let paper_shortfall = u16::from(255 - paper_reference(source));
    for (value, &outside) in gray.data_mut().iter_mut().zip(beyond.data()) {
        *value = value.saturating_sub(((u16::from(outside) * paper_shortfall + 127) / 255) as u8);
    }
    gray
}
