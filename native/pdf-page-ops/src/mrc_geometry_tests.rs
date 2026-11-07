use crate::page_sizes::{collect_page_sizes, tests::create_test_document};
use lopdf::{dictionary, Dictionary, Stream};

#[test]
fn page_geometry_rejects_a_reflected_nondominant_image() {
    let (mut document, page_id) = create_test_document();
    let image = |width, height| {
        Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => width, "Height" => height,
            },
            Vec::new(),
        )
    };
    let foreground = document.add_object(image(1000, 500));
    let background = document.add_object(image(200, 100));
    document.get_dictionary_mut(page_id).unwrap().set(
        "Resources",
        dictionary! {
            "XObject" => dictionary! { "Fg" => foreground, "Bg" => background },
        },
    );
    for (content, expected) in [
        ("q 200 0 0 100 0 0 cm /Fg Do /Bg Do Q", true),
        (
            "q 200 0 0 100 0 0 cm /Fg Do Q q -200 0 0 100 200 0 cm /Bg Do Q",
            false,
        ),
    ] {
        let stream =
            document.add_object(Stream::new(Dictionary::new(), content.as_bytes().to_vec()));
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Contents", stream);
        let pages = collect_page_sizes(&document).unwrap().pages;
        let page = serde_json::to_value(&pages[0]).unwrap();
        assert_eq!(page["dominantImageWidthPx"], 1000);
        assert_eq!(page["allImagesPageAligned"], expected);
    }
}
