use rayon::prelude::*;

/// Bit-packed binary image. Black pixels are one; words are MSB-first. Padding bits are zero.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BinaryImage {
    width: usize,
    height: usize,
    words_per_line: usize,
    words: Vec<u32>,
}

impl BinaryImage {
    /// Creates a white image. Each scanline is padded independently to a 32-bit word.
    pub fn new(width: usize, height: usize) -> Self {
        let words_per_line = width.div_ceil(32);
        Self {
            width,
            height,
            words_per_line,
            words: vec![0; words_per_line.saturating_mul(height)],
        }
    }

    /// Builds independent packed scanlines in parallel. Raster transforms use
    /// this instead of synchronizing one bit mutation at a time over large
    /// source pages.
    pub fn from_fn_parallel(
        width: usize,
        height: usize,
        predicate: impl Fn(usize, usize) -> bool + Sync,
    ) -> Self {
        let mut output = Self::new(width, height);
        if width == 0 || height == 0 {
            return output;
        }
        let words_per_line = output.words_per_line;
        output
            .words
            .par_chunks_mut(words_per_line)
            .enumerate()
            .for_each(|(y, row)| {
                for (word_x, target) in row.iter_mut().enumerate() {
                    let first_x = word_x * 32;
                    let mut word = 0u32;
                    for bit in 0..32 {
                        let x = first_x + bit;
                        if x < width && predicate(x, y) {
                            word |= 1 << (31 - bit);
                        }
                    }
                    *target = word;
                }
            });
        output
    }

    pub fn width(&self) -> usize {
        self.width
    }
    pub fn height(&self) -> usize {
        self.height
    }
    pub fn words_per_line(&self) -> usize {
        self.words_per_line
    }
    pub fn words(&self) -> &[u32] {
        &self.words
    }

    pub(crate) fn words_mut(&mut self) -> &mut [u32] {
        &mut self.words
    }

    pub fn get(&self, x: usize, y: usize) -> bool {
        let word = self.words[y * self.words_per_line + x / 32];
        word & (1 << (31 - x % 32)) != 0
    }

    pub fn set(&mut self, x: usize, y: usize, black: bool) {
        let index = y * self.words_per_line + x / 32;
        let mask = 1 << (31 - x % 32);
        if black {
            self.words[index] |= mask;
        } else {
            self.words[index] &= !mask;
        }
    }

    pub fn count_black(&self) -> usize {
        self.words
            .iter()
            .map(|word| word.count_ones() as usize)
            .sum()
    }

    pub fn invert(&self) -> Self {
        let mut output = self.clone();
        output.words.par_iter_mut().for_each(|word| *word = !*word);
        output.clear_padding();
        output
    }

    pub fn and(&self, other: &Self) -> Self {
        self.zip_words(other, |left, right| left & right)
    }

    pub fn or(&self, other: &Self) -> Self {
        self.zip_words(other, |left, right| left | right)
    }

    pub fn subtract(&self, other: &Self) -> Self {
        self.zip_words(other, |left, right| left & !right)
    }

    pub fn into_subtract(mut self, other: &Self) -> Self {
        self.zip_words_in_place(other, |left, right| left & !right);
        self
    }

    fn zip_words(&self, other: &Self, operation: impl Fn(u32, u32) -> u32 + Sync) -> Self {
        let mut output = self.clone();
        output.zip_words_in_place(other, operation);
        output
    }

    fn zip_words_in_place(&mut self, other: &Self, operation: impl Fn(u32, u32) -> u32 + Sync) {
        assert_eq!((self.width, self.height), (other.width, other.height));
        self.words
            .par_iter_mut()
            .zip(other.words.par_iter())
            .for_each(|(target, right)| *target = operation(*target, *right));
        self.clear_padding();
    }

    pub(crate) fn clear_padding(&mut self) {
        if self.width == 0 || self.width % 32 == 0 {
            return;
        }
        let mask = u32::MAX << (32 - self.width % 32);
        for y in 0..self.height {
            self.words[(y + 1) * self.words_per_line - 1] &= mask;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_msb_first_words_and_zero_padding() {
        let mut image = BinaryImage::new(33, 1);
        image.set(0, 0, true);
        image.set(32, 0, true);
        assert_eq!(image.words(), &[0x8000_0000, 0x8000_0000]);
        assert_eq!(image.invert().words(), &[0x7fff_ffff, 0]);
    }

    #[test]
    fn bit_operations_match_naive_pixels() {
        let mut a = BinaryImage::new(67, 3);
        let mut b = BinaryImage::new(67, 3);
        for y in 0..3 {
            for x in 0..67 {
                a.set(x, y, (x + y) % 3 == 0);
                b.set(x, y, (x * 2 + y) % 5 == 0);
            }
        }
        for y in 0..3 {
            for x in 0..67 {
                assert_eq!(a.and(&b).get(x, y), a.get(x, y) && b.get(x, y));
                assert_eq!(a.or(&b).get(x, y), a.get(x, y) || b.get(x, y));
                assert_eq!(a.subtract(&b).get(x, y), a.get(x, y) && !b.get(x, y));
            }
        }
        assert_eq!(a.clone().into_subtract(&b), a.subtract(&b));
    }

    #[test]
    fn parallel_builder_matches_individual_bit_writes() {
        let mut expected = BinaryImage::new(67, 43);
        for y in 0..expected.height() {
            for x in 0..expected.width() {
                expected.set(x, y, (x * 7 + y * 13) % 19 < 5);
            }
        }
        let actual = BinaryImage::from_fn_parallel(67, 43, |x, y| (x * 7 + y * 13) % 19 < 5);
        assert_eq!(actual, expected);
    }
}
