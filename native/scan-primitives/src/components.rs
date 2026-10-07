use crate::{BinaryImage, GrayImage};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Component {
    pub label: u32,
    pub area: usize,
    pub left: usize,
    pub top: usize,
    pub right: usize,
    pub bottom: usize,
}

#[derive(Clone, Copy, Debug)]
struct Run {
    start: u32,
    end: u32,
    label: u32,
}

#[derive(Clone, Debug)]
pub struct ComponentMap {
    width: usize,
    height: usize,
    row_offsets: Vec<usize>,
    runs: Vec<Run>,
    components: Vec<Component>,
}

impl ComponentMap {
    /// Labels black foreground with 8-connectivity.
    pub fn from_binary(image: &BinaryImage) -> Self {
        let width_u32 =
            u32::try_from(image.width()).expect("component map width exceeds u32 coordinates");
        let mut runs = Vec::new();
        let mut row_offsets = Vec::with_capacity(image.height().saturating_add(1));
        let mut parents = Vec::<u32>::new();
        row_offsets.push(0);

        for y in 0..image.height() {
            let word_start = y * image.words_per_line();
            let words = &image.words()[word_start..word_start + image.words_per_line()];
            let row_start = runs.len();
            extract_row_runs(words, width_u32, &mut runs);
            for run in &mut runs[row_start..] {
                let node = u32::try_from(parents.len())
                    .expect("component map contains more than u32::MAX runs");
                parents.push(node);
                run.label = node + 1;
            }

            if y > 0 {
                let previous_start = row_offsets[y - 1];
                let previous_end = row_offsets[y];
                let mut previous = previous_start;
                for current in row_start..runs.len() {
                    // Half-open [a, b) and [c, d) runs are 8-connected across
                    // adjacent rows when c <= b and a <= d. Equality is the
                    // one-pixel horizontal offset of a diagonal contact.
                    while previous < previous_end && runs[previous].end < runs[current].start {
                        previous += 1;
                    }
                    let mut candidate = previous;
                    while candidate < previous_end && runs[candidate].start <= runs[current].end {
                        union(
                            &mut parents,
                            runs[current].label - 1,
                            runs[candidate].label - 1,
                        );
                        candidate += 1;
                    }
                }
            }
            row_offsets.push(runs.len());
        }

        let mut root_labels = vec![0u32; parents.len()];
        let mut components = Vec::<Component>::new();
        for y in 0..image.height() {
            for stored_run in &mut runs[row_offsets[y]..row_offsets[y + 1]] {
                let run = *stored_run;
                let root = find(&mut parents, run.label - 1) as usize;
                let label = if root_labels[root] == 0 {
                    let label = u32::try_from(components.len() + 1)
                        .expect("component map contains more than u32::MAX components");
                    root_labels[root] = label;
                    components.push(Component {
                        label,
                        area: 0,
                        left: run.start as usize,
                        top: y,
                        right: run.end as usize - 1,
                        bottom: y,
                    });
                    label
                } else {
                    root_labels[root]
                };
                stored_run.label = label;
                let component = &mut components[label as usize - 1];
                component.area += (run.end - run.start) as usize;
                component.left = component.left.min(run.start as usize);
                component.right = component.right.max(run.end as usize - 1);
                component.bottom = y;
            }
        }

        Self {
            width: image.width(),
            height: image.height(),
            row_offsets,
            runs,
            components,
        }
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn label_at(&self, x: usize, y: usize) -> u32 {
        let row = &self.runs[self.row_offsets[y]..self.row_offsets[y + 1]];
        let candidate = row.partition_point(|run| run.end as usize <= x);
        row.get(candidate)
            .filter(|run| run.start as usize <= x)
            .map_or(0, |run| run.label)
    }

    pub fn components(&self) -> &[Component] {
        &self.components
    }

    /// Maximum value under each foreground component. Iterating stored runs
    /// avoids a full-page label lookup for every white pixel.
    pub fn maximum_values_by_component(&self, values: &[u32]) -> Vec<u32> {
        assert_eq!(values.len(), self.width.saturating_mul(self.height));
        let mut maxima = vec![0u32; self.components.len() + 1];
        for y in 0..self.height {
            for run in &self.runs[self.row_offsets[y]..self.row_offsets[y + 1]] {
                let target = &mut maxima[run.label as usize];
                for x in run.start as usize..run.end as usize {
                    *target = (*target).max(values[y * self.width + x]);
                }
            }
        }
        maxima
    }

    /// Luminance sum and sample count under each foreground component.
    pub fn gray_sums_by_component(&self, image: &GrayImage) -> (Vec<u64>, Vec<usize>) {
        assert_eq!((image.width(), image.height()), (self.width, self.height));
        let mut sums = vec![0u64; self.components.len() + 1];
        let mut counts = vec![0usize; self.components.len() + 1];
        for y in 0..self.height {
            for run in &self.runs[self.row_offsets[y]..self.row_offsets[y + 1]] {
                let label = run.label as usize;
                for x in run.start as usize..run.end as usize {
                    sums[label] += u64::from(image.get(x, y));
                    counts[label] += 1;
                }
            }
        }
        (sums, counts)
    }

    /// Black `mask` pixels under each foreground component.
    pub fn mask_counts_by_component(&self, mask: &BinaryImage) -> Vec<usize> {
        assert_eq!((mask.width(), mask.height()), (self.width, self.height));
        let mut counts = vec![0usize; self.components.len() + 1];
        for y in 0..self.height {
            for run in &self.runs[self.row_offsets[y]..self.row_offsets[y + 1]] {
                counts[run.label as usize] += (run.start as usize..run.end as usize)
                    .filter(|&x| mask.get(x, y))
                    .count();
            }
        }
        counts
    }

    pub fn retain(&self, keep: impl Fn(&Component) -> bool) -> BinaryImage {
        let mut accepted = vec![false; self.components.len() + 1];
        for component in &self.components {
            accepted[component.label as usize] = keep(component);
        }
        let mut image = BinaryImage::new(self.width, self.height);
        for y in 0..self.height {
            for run in &self.runs[self.row_offsets[y]..self.row_offsets[y + 1]] {
                if accepted[run.label as usize] {
                    set_black_run(&mut image, y, run.start as usize, run.end as usize);
                }
            }
        }
        image
    }
}

fn extract_row_runs(words: &[u32], width: u32, runs: &mut Vec<Run>) {
    let row_start = runs.len();
    for (word_index, &source_word) in words.iter().enumerate() {
        let base = word_index * 32;
        let valid_bits = (width as usize).saturating_sub(base).min(32);
        let mut word = source_word;
        let mut consumed = 0usize;
        while consumed < valid_bits {
            let zeros = word.leading_zeros() as usize;
            if zeros >= valid_bits - consumed {
                break;
            }
            consumed += zeros;
            if zeros != 0 {
                word <<= zeros;
            }
            let ones = (word.leading_ones() as usize).min(valid_bits - consumed);
            let start = (base + consumed) as u32;
            let end = (base + consumed + ones) as u32;
            if runs.len() > row_start && runs.last().is_some_and(|run| run.end == start) {
                runs.last_mut().unwrap().end = end;
            } else {
                runs.push(Run {
                    start,
                    end,
                    label: 0,
                });
            }
            consumed += ones;
            if consumed < valid_bits {
                word <<= ones;
            }
        }
    }
}

fn find(parents: &mut [u32], node: u32) -> u32 {
    let mut root = node;
    while parents[root as usize] != root {
        root = parents[root as usize];
    }
    let mut current = node;
    while parents[current as usize] != current {
        let next = parents[current as usize];
        parents[current as usize] = root;
        current = next;
    }
    root
}

fn union(parents: &mut [u32], left: u32, right: u32) {
    let left_root = find(parents, left);
    let right_root = find(parents, right);
    if left_root != right_root {
        let (root, child) = if left_root < right_root {
            (left_root, right_root)
        } else {
            (right_root, left_root)
        };
        parents[child as usize] = root;
    }
}

fn set_black_run(image: &mut BinaryImage, y: usize, start: usize, end: usize) {
    let words_per_line = image.words_per_line();
    let first = y * words_per_line + start / 32;
    let last = y * words_per_line + (end - 1) / 32;
    let words = image.words_mut();
    if first == last {
        let left_mask = u32::MAX >> (start % 32);
        let end_offset = end % 32;
        let right_mask = if end_offset == 0 {
            u32::MAX
        } else {
            u32::MAX << (32 - end_offset)
        };
        words[first] |= left_mask & right_mask;
        return;
    }
    words[first] |= u32::MAX >> (start % 32);
    for word in &mut words[first + 1..last] {
        *word = u32::MAX;
    }
    let end_offset = end % 32;
    words[last] |= if end_offset == 0 {
        u32::MAX
    } else {
        u32::MAX << (32 - end_offset)
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        time::{Duration, Instant},
    };

    #[derive(Debug)]
    struct ReferenceMap {
        width: usize,
        height: usize,
        labels: Vec<u32>,
        components: Vec<Component>,
    }

    impl ReferenceMap {
        fn from_binary(image: &BinaryImage) -> Self {
            let mut labels = vec![0u32; image.width().saturating_mul(image.height())];
            let mut components = Vec::new();
            let mut queue = VecDeque::new();
            for y in 0..image.height() {
                for x in 0..image.width() {
                    if !image.get(x, y) || labels[y * image.width() + x] != 0 {
                        continue;
                    }
                    let label = (components.len() + 1) as u32;
                    labels[y * image.width() + x] = label;
                    queue.push_back((x, y));
                    let mut component = Component {
                        label,
                        area: 0,
                        left: x,
                        top: y,
                        right: x,
                        bottom: y,
                    };
                    while let Some((cx, cy)) = queue.pop_front() {
                        component.area += 1;
                        component.left = component.left.min(cx);
                        component.right = component.right.max(cx);
                        component.top = component.top.min(cy);
                        component.bottom = component.bottom.max(cy);
                        for ny in cy.saturating_sub(1)..=(cy + 1).min(image.height() - 1) {
                            for nx in cx.saturating_sub(1)..=(cx + 1).min(image.width() - 1) {
                                let index = ny * image.width() + nx;
                                if image.get(nx, ny) && labels[index] == 0 {
                                    labels[index] = label;
                                    queue.push_back((nx, ny));
                                }
                            }
                        }
                    }
                    components.push(component);
                }
            }
            Self {
                width: image.width(),
                height: image.height(),
                labels,
                components,
            }
        }

        fn label_at(&self, x: usize, y: usize) -> u32 {
            self.labels[y * self.width + x]
        }

        fn retain(&self, keep: impl Fn(&Component) -> bool) -> BinaryImage {
            let mut accepted = vec![false; self.components.len() + 1];
            for component in &self.components {
                accepted[component.label as usize] = keep(component);
            }
            let mut image = BinaryImage::new(self.width, self.height);
            for y in 0..self.height {
                for x in 0..self.width {
                    let label = self.label_at(x, y) as usize;
                    image.set(x, y, label != 0 && accepted[label]);
                }
            }
            image
        }
    }

    fn next_random(state: &mut u64) -> u64 {
        *state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *state
    }

    fn assert_equivalent(image: &BinaryImage) {
        let expected = ReferenceMap::from_binary(image);
        let actual = ComponentMap::from_binary(image);
        assert_eq!(
            (actual.width(), actual.height()),
            (image.width(), image.height())
        );
        assert_eq!(actual.components().len(), expected.components.len());

        let mut actual_to_expected = vec![0u32; actual.components().len() + 1];
        let mut expected_to_actual = vec![0u32; expected.components.len() + 1];
        for y in 0..image.height() {
            for x in 0..image.width() {
                let actual_label = actual.label_at(x, y);
                let expected_label = expected.label_at(x, y);
                assert_eq!(actual_label == 0, expected_label == 0);
                if actual_label != 0 {
                    let mapped = &mut actual_to_expected[actual_label as usize];
                    if *mapped == 0 {
                        *mapped = expected_label;
                    }
                    assert_eq!(*mapped, expected_label);
                    let reverse = &mut expected_to_actual[expected_label as usize];
                    if *reverse == 0 {
                        *reverse = actual_label;
                    }
                    assert_eq!(*reverse, actual_label);
                }
            }
        }

        let mut actual_stats = actual
            .components()
            .iter()
            .map(|component| {
                (
                    component.area,
                    component.left,
                    component.top,
                    component.right,
                    component.bottom,
                )
            })
            .collect::<Vec<_>>();
        let mut expected_stats = expected
            .components
            .iter()
            .map(|component| {
                (
                    component.area,
                    component.left,
                    component.top,
                    component.right,
                    component.bottom,
                )
            })
            .collect::<Vec<_>>();
        actual_stats.sort_unstable();
        expected_stats.sort_unstable();
        assert_eq!(actual_stats, expected_stats);

        let keep = |component: &Component| {
            (component.area + component.left + component.top + component.bottom).is_multiple_of(3)
        };
        assert_eq!(actual.retain(keep), expected.retain(keep));
    }

    #[test]
    fn labels_diagonal_pixels_together() {
        let mut image = BinaryImage::new(5, 5);
        image.set(1, 1, true);
        image.set(2, 2, true);
        image.set(4, 4, true);
        let map = ComponentMap::from_binary(&image);
        assert_eq!(map.components().len(), 2);
        assert_eq!(map.components()[0].area, 2);
    }

    #[test]
    fn extracts_runs_across_word_boundaries_and_masks_padding() {
        let mut image = BinaryImage::new(67, 2);
        for x in 29..36 {
            image.set(x, 0, true);
        }
        for x in 35..67 {
            image.set(x, 1, true);
        }
        let map = ComponentMap::from_binary(&image);
        assert_eq!(map.components().len(), 1);
        assert_eq!(map.components()[0].area, 39);
        assert_eq!(map.retain(|_| true), image);
    }

    #[test]
    fn randomized_run_labeling_matches_reference_flood_fill() {
        let mut state = 0x4c43_475f_5255_4e53;
        for case in 0..180 {
            let width = (next_random(&mut state) as usize % 73) + usize::from(case % 17 != 0);
            let height = (next_random(&mut state) as usize % 41) + usize::from(case % 19 != 0);
            let threshold = next_random(&mut state) as u8;
            let mut image = BinaryImage::new(width, height);
            for y in 0..height {
                for x in 0..width {
                    image.set(x, y, next_random(&mut state) as u8 <= threshold);
                }
            }
            assert_equivalent(&image);
        }
    }

    #[test]
    #[ignore = "benchmark-style comparison; run explicitly with --ignored --nocapture"]
    fn benchmark_run_labeling_on_noisy_4000_by_3000_page() {
        let mut state = 0x5045_5246_5f50_3343;
        let mut image = BinaryImage::new(4000, 3000);
        for y in 0..image.height() {
            for x in 0..image.width() {
                image.set(x, y, next_random(&mut state) >> 61 == 0);
            }
        }

        let started = Instant::now();
        let expected = ReferenceMap::from_binary(&image);
        let old_elapsed = started.elapsed();
        let started = Instant::now();
        let actual = ComponentMap::from_binary(&image);
        let new_elapsed = started.elapsed();
        assert_eq!(actual.components().len(), expected.components.len());
        assert!(old_elapsed > Duration::ZERO);
        assert!(new_elapsed > Duration::ZERO);
        eprintln!(
            "components 4000x3000 noisy: old={old_elapsed:?} new={new_elapsed:?} speedup={:.2}x components={}",
            old_elapsed.as_secs_f64() / new_elapsed.as_secs_f64(),
            actual.components().len()
        );
    }
}
