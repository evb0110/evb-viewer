use crate::{bounded_io::record_deserialization_error, NativeErrorCode};
use serde::de::{DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::fmt;

pub const MAX_BOOKMARK_ITEMS: usize = 5_000;
pub const MAX_BOOKMARK_DEPTH: usize = 64;
pub const MAX_PAGE_LABEL_RANGES: usize = 2_048;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageLabelRange {
    pub start_page: u32,
    pub style: Option<String>,
    pub prefix: String,
    pub start_number: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum BookmarkSourceTarget {
    PageIndex(u32),
    Reference { num: u32, gen: u16 },
}

impl<'de> Deserialize<'de> for BookmarkSourceTarget {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Target;
        impl<'de> Visitor<'de> for Target {
            type Value = BookmarkSourceTarget;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a page index or a bounded page reference")
            }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                u32::try_from(value)
                    .map(BookmarkSourceTarget::PageIndex)
                    .map_err(E::custom)
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut num = None;
                let mut gen = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "num" if num.is_none() => num = Some(map.next_value::<u32>()?),
                        "gen" if gen.is_none() => gen = Some(map.next_value::<u16>()?),
                        "num" | "gen" => {
                            return Err(serde::de::Error::custom("Duplicate page reference field"))
                        }
                        _ => return Err(serde::de::Error::unknown_field(&key, &["num", "gen"])),
                    }
                }
                let num = num.ok_or_else(|| serde::de::Error::missing_field("num"))?;
                if num == 0 {
                    return Err(serde::de::Error::custom("Invalid page reference"));
                }
                Ok(BookmarkSourceTarget::Reference {
                    num,
                    gen: gen.ok_or_else(|| serde::de::Error::missing_field("gen"))?,
                })
            }
        }
        // An untagged derive buffers the whole value before checking its shape.
        // Visit its two bounded shapes directly, before any nested input is read.
        deserializer.deserialize_any(Target)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub enum BookmarkDestinationKind {
    XYZ,
    Fit,
    FitH,
    FitV,
    FitR,
    FitB,
    FitBH,
    FitBV,
}

impl BookmarkDestinationKind {
    pub fn coordinate_count(self) -> usize {
        match self {
            Self::XYZ => 3,
            Self::Fit | Self::FitB => 0,
            Self::FitR => 4,
            _ => 1,
        }
    }

    pub fn pdf_name(self) -> Vec<u8> {
        serde_json::json!(self).as_str().unwrap_or_default().into()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkOriginalDestination {
    pub kind: BookmarkDestinationKind,
    pub source_target: BookmarkSourceTarget,
    pub coordinates: Vec<Option<f64>>,
}

impl<'de> Deserialize<'de> for BookmarkOriginalDestination {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            kind: BookmarkDestinationKind,
            source_target: BookmarkSourceTarget,
            #[serde(deserialize_with = "deserialize_destination_coordinates")]
            coordinates: Vec<Option<f64>>,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.coordinates.len() != wire.kind.coordinate_count()
            || wire
                .coordinates
                .iter()
                .flatten()
                .any(|value| !(*value as f32).is_finite())
        {
            return Err(serde::de::Error::custom(
                "Invalid original bookmark destination",
            ));
        }
        Ok(Self {
            kind: wire.kind,
            source_target: wire.source_target,
            coordinates: wire.coordinates,
        })
    }
}

fn deserialize_destination_coordinates<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<Option<f64>>, D::Error> {
    struct Coordinates;
    impl<'de> Visitor<'de> for Coordinates {
        type Value = Vec<Option<f64>>;
        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("at most four numeric or null destination coordinates")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
            let mut coordinates = Vec::with_capacity(4);
            while let Some(value) = sequence.next_element()? {
                if coordinates.len() == 4 {
                    return Err(serde::de::Error::custom(
                        "Too many bookmark destination coordinates",
                    ));
                }
                coordinates.push(value);
            }
            Ok(coordinates)
        }
    }
    deserializer.deserialize_seq(Coordinates)
}

/// The size ceiling of one outline action: one per value plus the bytes of
/// its names, keys and strings.
pub const MAX_BOOKMARK_ACTION_SIZE: usize = 16_384;

/// An outline item's own action other than GoTo (GoToR, Launch, URI, ...),
/// kept as a value without object references so that page rewrites, which
/// renumber objects, cannot retarget it. Dictionaries keep their key order and
/// strings their bytes and form, so an untouched action is written back as it
/// was read.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(untagged)]
pub enum BookmarkActionValue {
    Null,
    Boolean(bool),
    Integer(i64),
    Array(Vec<BookmarkActionValue>),
    Tagged(BookmarkActionTag),
}

/// The PDF value kinds JSON cannot tell apart.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BookmarkActionTag {
    Real(f64),
    Name(String),
    Literal(Vec<u8>),
    Hex(Vec<u8>),
    Dict(Vec<(String, BookmarkActionValue)>),
}

impl BookmarkActionValue {
    pub fn size(&self) -> usize {
        1 + match self {
            Self::Array(items) => items.iter().map(Self::size).sum(),
            Self::Tagged(BookmarkActionTag::Name(name)) => name.len(),
            Self::Tagged(BookmarkActionTag::Literal(bytes) | BookmarkActionTag::Hex(bytes)) => {
                bytes.len()
            }
            Self::Tagged(BookmarkActionTag::Dict(entries)) => entries
                .iter()
                .map(|(key, value)| key.len() + value.size())
                .sum(),
            _ => 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookmarkEntry {
    pub title: String,
    pub page_index: Option<u32>,
    #[serde(default)]
    pub page_y_ratio: Option<f64>,
    #[serde(default)]
    pub named_dest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_destination: Option<BookmarkOriginalDestination>,
    /// Written only when the entry has no destination of its own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_action: Option<BookmarkActionValue>,
    /// The name's source form, kept when Save would write the name differently.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_named_dest: Option<BookmarkActionValue>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub color: Option<String>,
    pub items: Vec<BookmarkEntry>,
}

struct BookmarkBudget {
    items: usize,
}

struct BookmarkSeed<'a> {
    budget: &'a mut BookmarkBudget,
    depth: usize,
}

struct BookmarkListSeed<'a> {
    budget: &'a mut BookmarkBudget,
    depth: usize,
}

struct BookmarkVisitor<'a> {
    budget: &'a mut BookmarkBudget,
    depth: usize,
}

struct BookmarkListVisitor<'a> {
    budget: &'a mut BookmarkBudget,
    depth: usize,
}

impl<'de, 'a> DeserializeSeed<'de> for BookmarkSeed<'a> {
    type Value = BookmarkEntry;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        if self.depth >= MAX_BOOKMARK_DEPTH {
            record_deserialization_error(NativeErrorCode::TooLarge);
            return Err(serde::de::Error::custom(format!(
                "bookmark tree exceeds the {MAX_BOOKMARK_DEPTH}-level admission ceiling"
            )));
        }
        if self.budget.items >= MAX_BOOKMARK_ITEMS {
            record_deserialization_error(NativeErrorCode::TooLarge);
            return Err(serde::de::Error::custom(format!(
                "bookmark tree exceeds the {MAX_BOOKMARK_ITEMS}-item admission ceiling"
            )));
        }
        self.budget.items += 1;
        deserializer.deserialize_map(BookmarkVisitor {
            budget: self.budget,
            depth: self.depth,
        })
    }
}

impl<'de, 'a> DeserializeSeed<'de> for BookmarkListSeed<'a> {
    type Value = Vec<BookmarkEntry>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(BookmarkListVisitor {
            budget: self.budget,
            depth: self.depth,
        })
    }
}

impl<'de, 'a> Visitor<'de> for BookmarkListVisitor<'a> {
    type Value = Vec<BookmarkEntry>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a bounded bookmark array")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let capacity = sequence.size_hint().unwrap_or(0).min(MAX_BOOKMARK_ITEMS);
        let mut items = Vec::with_capacity(capacity);
        while let Some(item) = sequence.next_element_seed(BookmarkSeed {
            budget: self.budget,
            depth: self.depth,
        })? {
            items.push(item);
        }
        Ok(items)
    }
}

impl<'de, 'a> Visitor<'de> for BookmarkVisitor<'a> {
    type Value = BookmarkEntry;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a bookmark object")
    }

    fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
    where
        M: MapAccess<'de>,
    {
        let mut title = None;
        let mut page_index = None;
        let mut page_y_ratio = None;
        let mut named_dest = None;
        let mut original_destination = None;
        let mut original_action = None;
        let mut original_named_dest = None;
        let mut bold = false;
        let mut italic = false;
        let mut color = None;
        let mut items = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "title" => title = Some(map.next_value()?),
                "pageIndex" => page_index = Some(map.next_value()?),
                "pageYRatio" => page_y_ratio = map.next_value()?,
                "namedDest" => named_dest = map.next_value()?,
                "originalDestination" => original_destination = map.next_value()?,
                "originalAction" => original_action = map.next_value()?,
                "originalNamedDest" => original_named_dest = map.next_value()?,
                "bold" => bold = map.next_value()?,
                "italic" => italic = map.next_value()?,
                "color" => color = map.next_value()?,
                "items" => {
                    items = Some(map.next_value_seed(BookmarkListSeed {
                        budget: self.budget,
                        depth: self.depth + 1,
                    })?);
                }
                _ => return Err(serde::de::Error::unknown_field(&key, BOOKMARK_FIELDS)),
            }
        }
        Ok(BookmarkEntry {
            title: title.ok_or_else(|| serde::de::Error::missing_field("title"))?,
            page_index: page_index.unwrap_or(None),
            page_y_ratio,
            named_dest,
            original_destination,
            original_action,
            original_named_dest,
            bold,
            italic,
            color,
            items: items.unwrap_or_default(),
        })
    }
}

const BOOKMARK_FIELDS: &[&str] = &[
    "title",
    "pageIndex",
    "pageYRatio",
    "namedDest",
    "originalDestination",
    "originalAction",
    "originalNamedDest",
    "bold",
    "italic",
    "color",
    "items",
];

impl<'de> Deserialize<'de> for BookmarkEntry {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let mut budget = BookmarkBudget { items: 0 };
        BookmarkSeed {
            budget: &mut budget,
            depth: 0,
        }
        .deserialize(deserializer)
    }
}

pub fn deserialize_bounded_bookmark_items<'de, D>(
    deserializer: D,
) -> Result<Vec<BookmarkEntry>, D::Error>
where
    D: Deserializer<'de>,
{
    let mut budget = BookmarkBudget { items: 0 };
    BookmarkListSeed {
        budget: &mut budget,
        depth: 0,
    }
    .deserialize(deserializer)
}

pub fn clamp_u32(value: u32, min: u32, max: u32) -> u32 {
    value.max(min).min(max)
}

pub fn normalize_page_label_style(style: Option<&str>) -> Option<String> {
    match style {
        Some("D" | "R" | "r" | "A" | "a") => style.map(ToOwned::to_owned),
        Some(_) => Some("D".to_string()),
        None => None,
    }
}

pub fn normalize_page_label_ranges(
    ranges: &[PageLabelRange],
    total_pages: u32,
) -> Vec<PageLabelRange> {
    if total_pages == 0 {
        return Vec::new();
    }

    let mut deduped = std::collections::BTreeMap::new();
    for range in ranges {
        let start_page = clamp_u32(range.start_page.max(1), 1, total_pages);
        deduped.insert(
            start_page,
            PageLabelRange {
                start_page,
                style: normalize_page_label_style(range.style.as_deref()),
                prefix: range.prefix.clone(),
                start_number: range.start_number.max(1),
            },
        );
    }
    deduped.entry(1).or_insert_with(|| PageLabelRange {
        start_page: 1,
        style: Some("D".to_string()),
        prefix: String::new(),
        start_number: 1,
    });
    deduped.into_values().collect()
}

pub fn is_implicit_default_page_labels(ranges: &[PageLabelRange], total_pages: u32) -> bool {
    let normalized = normalize_page_label_ranges(ranges, total_pages);
    normalized.len() == 1
        && normalized[0].start_page == 1
        && normalized[0].style.as_deref() == Some("D")
        && normalized[0].prefix.is_empty()
        && normalized[0].start_number == 1
}

pub fn normalize_bookmark_color(color: Option<&str>) -> Option<String> {
    parse_pdf_color(color).map(|rgb| {
        let to_byte = |value: f64| -> u8 { (value.clamp(0.0, 1.0) * 255.0).round() as u8 };
        format!(
            "#{:02x}{:02x}{:02x}",
            to_byte(rgb[0]),
            to_byte(rgb[1]),
            to_byte(rgb[2])
        )
    })
}

pub fn normalize_bookmark_entries(
    items: &[BookmarkEntry],
    total_pages: u32,
    untitled_label: &str,
) -> Vec<BookmarkEntry> {
    if total_pages == 0 {
        return Vec::new();
    }
    let max_page_index = total_pages - 1;
    items
        .iter()
        .map(|item| {
            let title = item.title.trim();
            let named_dest = item
                .named_dest
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            BookmarkEntry {
                title: if title.is_empty() {
                    untitled_label.to_string()
                } else {
                    title.to_string()
                },
                page_index: item
                    .page_index
                    .map(|page_index| page_index.min(max_page_index)),
                page_y_ratio: item
                    .page_y_ratio
                    .filter(|value| value.is_finite())
                    .map(|value| value.clamp(0.0, 1.0)),
                named_dest,
                original_destination: item.original_destination.clone(),
                original_action: item.original_action.clone(),
                original_named_dest: item.original_named_dest.clone(),
                bold: item.bold,
                italic: item.italic,
                color: normalize_bookmark_color(item.color.as_deref()),
                items: normalize_bookmark_entries(&item.items, total_pages, untitled_label),
            }
        })
        .collect()
}

fn parse_hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn parse_hex_color_component(high: u8, low: u8) -> Option<f64> {
    Some(f64::from(parse_hex_digit(high)? * 16 + parse_hex_digit(low)?) / 255.0)
}

fn parse_rgb_number(value: &str) -> Option<f64> {
    let parsed = value.trim().parse::<f64>().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    Some(parsed.clamp(0.0, 255.0) / 255.0)
}

fn parse_pdf_color(color: Option<&str>) -> Option<[f64; 3]> {
    let trimmed = color?.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("transparent")
        || trimmed.eq_ignore_ascii_case("none")
    {
        return None;
    }

    if let Some(hex) = trimmed.strip_prefix('#') {
        let bytes = hex.as_bytes();
        if bytes.len() == 3 {
            return Some([
                parse_hex_color_component(bytes[0], bytes[0])?,
                parse_hex_color_component(bytes[1], bytes[1])?,
                parse_hex_color_component(bytes[2], bytes[2])?,
            ]);
        }
        if bytes.len() == 6 {
            return Some([
                parse_hex_color_component(bytes[0], bytes[1])?,
                parse_hex_color_component(bytes[2], bytes[3])?,
                parse_hex_color_component(bytes[4], bytes[5])?,
            ]);
        }
    }

    let lower = trimmed.to_ascii_lowercase();
    let args = lower
        .strip_prefix("rgb(")
        .and_then(|value| value.strip_suffix(')'))
        .or_else(|| {
            lower
                .strip_prefix("rgba(")
                .and_then(|value| value.strip_suffix(')'))
        })?;
    let mut parts = args.split(',');
    Some([
        parse_rgb_number(parts.next()?)?,
        parse_rgb_number(parts.next()?)?,
        parse_rgb_number(parts.next()?)?,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize)]
    struct BookmarkRoot {
        #[serde(deserialize_with = "deserialize_bounded_bookmark_items")]
        items: Vec<BookmarkEntry>,
    }

    fn nested_reference_bookmarks(depth: usize) -> String {
        let prefix = r#"{"title":"nested","pageIndex":0,"originalDestination":{"kind":"Fit","sourceTarget":{"num":3,"gen":0},"coordinates":[]},"items":["#;
        format!(
            r#"{{"items":[{}{}]}}"#,
            prefix.repeat(depth),
            "]}".repeat(depth)
        )
    }

    #[test]
    fn accepts_full_bounded_depth_with_reference_destinations() {
        let source = nested_reference_bookmarks(MAX_BOOKMARK_DEPTH);
        let root: BookmarkRoot =
            crate::bounded_io::deserialize_json_slice(source.as_bytes(), "bookmarks").unwrap();
        let mut items = root.items.as_slice();
        for _ in 0..MAX_BOOKMARK_DEPTH {
            assert_eq!(items.len(), 1);
            assert!(items[0].original_destination.is_some());
            items = &items[0].items;
        }
        assert!(items.is_empty());
    }

    #[test]
    fn refuses_a_hundred_thousand_levels_at_the_bookmark_admission_boundary() {
        let source = nested_reference_bookmarks(100_000);
        let error = crate::bounded_io::deserialize_json_slice::<BookmarkRoot>(
            source.as_bytes(),
            "bookmarks",
        )
        .unwrap_err();
        assert_eq!(error.code, NativeErrorCode::TooLarge);
        assert!(
            error.message.contains("64-level admission ceiling"),
            "{}",
            error.message
        );
        let path =
            std::env::temp_dir().join(format!("evb-bookmark-deep-{}.json", std::process::id()));
        std::fs::write(&path, &source).unwrap();
        let error = crate::bounded_io::deserialize_json_file_bounded::<BookmarkRoot>(
            &path,
            source.len(),
            "bookmarks",
        )
        .unwrap_err();
        std::fs::remove_file(path).unwrap();
        assert_eq!(error.code, NativeErrorCode::TooLarge);
        assert!(
            error.message.contains("64-level admission ceiling"),
            "{}",
            error.message
        );
    }

    #[test]
    fn refuses_nested_source_targets_without_buffering_them() {
        let nested = format!(
            "{}0{}",
            r#"{"nested":"#.repeat(100_000),
            "}".repeat(100_000)
        );
        let source = format!(
            r#"{{"kind":"Fit","sourceTarget":{{"num":{nested},"gen":0}},"coordinates":[]}}"#
        );
        let error = crate::bounded_io::deserialize_json_slice::<BookmarkOriginalDestination>(
            source.as_bytes(),
            "destination",
        )
        .unwrap_err();
        assert_eq!(error.code, NativeErrorCode::InvalidRequest);
        assert!(
            !error.message.contains("recursion limit"),
            "{}",
            error.message
        );
    }

    #[test]
    fn rejects_unbounded_or_incomplete_original_destinations() {
        for invalid in [
            r#"{"kind":"XYZ","sourceTarget":0,"coordinates":[null]}"#,
            r#"{"kind":"FitR","sourceTarget":0,"coordinates":[0,0,100,100,0]}"#,
            r#"{"kind":"FitH","sourceTarget":{"num":0,"gen":0},"coordinates":[null]}"#,
            r#"{"kind":"FitH","sourceTarget":0,"coordinates":[1e100]}"#,
            r#"{"kind":"unknown","sourceTarget":0,"coordinates":[]}"#,
        ] {
            assert!(serde_json::from_str::<BookmarkOriginalDestination>(invalid).is_err());
        }
        let destination: BookmarkOriginalDestination = serde_json::from_str(
            r#"{"kind":"XYZ","sourceTarget":{"num":17,"gen":0},"coordinates":[null,null,null]}"#,
        )
        .unwrap();
        assert_eq!(destination.coordinates, vec![None, None, None]);
    }

    #[test]
    fn normalizes_page_label_ranges_by_page_and_adds_default() {
        let ranges = normalize_page_label_ranges(
            &[
                PageLabelRange {
                    start_page: 0,
                    style: Some("invalid".to_string()),
                    prefix: "front-".to_string(),
                    start_number: 0,
                },
                PageLabelRange {
                    start_page: 99,
                    style: Some("r".to_string()),
                    prefix: "back-".to_string(),
                    start_number: 3,
                },
            ],
            4,
        );

        assert_eq!(ranges[0].start_page, 1);
        assert_eq!(ranges[0].style.as_deref(), Some("D"));
        assert_eq!(ranges[0].start_number, 1);
        assert_eq!(ranges[1].start_page, 4);
    }

    #[test]
    fn normalizes_bookmark_text_and_color() {
        let normalized = normalize_bookmark_entries(
            &[BookmarkEntry {
                title: "  Chapter 1  ".to_string(),
                page_index: Some(99),
                page_y_ratio: Some(f64::NAN),
                named_dest: Some("  ".to_string()),
                original_destination: None,
                original_action: None,
                original_named_dest: None,
                bold: true,
                italic: false,
                color: Some("#abc".to_string()),
                items: Vec::new(),
            }],
            2,
            "Untitled",
        );

        assert_eq!(normalized[0].title, "Chapter 1");
        assert_eq!(normalized[0].page_index, Some(1));
        assert_eq!(normalized[0].page_y_ratio, None);
        assert_eq!(normalized[0].named_dest, None);
        assert_eq!(normalized[0].color.as_deref(), Some("#aabbcc"));
    }

    #[test]
    fn rejects_bookmark_depth_before_descending() {
        #[allow(dead_code)]
        #[derive(Debug, Deserialize)]
        struct BookmarkRoot {
            #[serde(deserialize_with = "deserialize_bounded_bookmark_items")]
            items: Vec<BookmarkEntry>,
        }
        let mut json = String::new();
        for _ in 0..=MAX_BOOKMARK_DEPTH {
            json.push_str(r#"{"title":"nested","pageIndex":0,"items":["#);
        }
        json.push_str(r#"{"title":"leaf","pageIndex":0}"#);
        for _ in 0..=MAX_BOOKMARK_DEPTH {
            json.push_str("]}");
        }

        let source = format!(r#"{{"items":[{json}]}}"#);
        let error = BookmarkRoot::deserialize(&mut serde_json::Deserializer::from_str(&source))
            .expect_err("deep bookmark trees must be rejected");
        assert!(
            error.to_string().contains("admission ceiling")
                || error.to_string().contains("recursion limit"),
            "{error}"
        );
    }

    #[test]
    fn rejects_bookmark_count_across_the_whole_tree() {
        #[allow(dead_code)]
        #[derive(Debug, Deserialize)]
        struct BookmarkRoot {
            #[serde(deserialize_with = "deserialize_bounded_bookmark_items")]
            items: Vec<BookmarkEntry>,
        }
        let item = r#"{"title":"item","pageIndex":0}"#;
        let json = format!(
            r#"{{"items":[{}]}}"#,
            std::iter::repeat_n(item, MAX_BOOKMARK_ITEMS + 1)
                .collect::<Vec<_>>()
                .join(",")
        );

        let error = serde_json::from_str::<BookmarkRoot>(&json)
            .expect_err("bookmark trees over the aggregate item limit must be rejected");
        assert!(
            error.to_string().contains("item admission ceiling"),
            "{error}"
        );
    }
}
