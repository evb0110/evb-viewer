use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum PageHalf {
    Full,
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedMargins {
    pub left_px: f64,
    pub top_px: f64,
    pub right_px: f64,
    pub bottom_px: f64,
}

impl From<[f64; 4]> for AppliedMargins {
    fn from([left_px, top_px, right_px, bottom_px]: [f64; 4]) -> Self {
        Self {
            left_px,
            top_px,
            right_px,
            bottom_px,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum CanvasScope {
    Page,
    #[default]
    Document,
}
