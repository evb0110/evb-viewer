//! Parallel iteration helpers backed by Rayon on native targets and
//! `wasm32-wasip1-threads`, and zero-overhead sequential iterators on
//! single-threaded `wasm32-unknown-unknown`.

#[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
pub use rayon::{current_num_threads, join, prelude, ThreadPool, ThreadPoolBuilder};

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
mod sequential {
    use std::iter::{Enumerate, FilterMap, FlatMap, Flatten, Map, Skip, Take, Zip};

    #[inline]
    pub fn current_num_threads() -> usize {
        1
    }

    #[inline]
    pub fn join<A, B, RA, RB>(oper_a: A, oper_b: B) -> (RA, RB)
    where
        A: FnOnce() -> RA,
        B: FnOnce() -> RB,
    {
        (oper_a(), oper_b())
    }

    pub struct ThreadPool;

    impl ThreadPool {
        #[inline]
        pub fn install<OP, R>(&self, op: OP) -> R
        where
            OP: FnOnce() -> R,
        {
            op()
        }
    }

    #[derive(Default)]
    pub struct ThreadPoolBuilder;

    impl ThreadPoolBuilder {
        #[inline]
        pub fn new() -> Self {
            Self
        }

        #[inline]
        pub fn num_threads(self, _num_threads: usize) -> Self {
            self
        }

        #[inline]
        pub fn thread_name<F>(self, _closure: F) -> Self
        where
            F: FnMut(usize) -> String + 'static,
        {
            self
        }

        #[inline]
        pub fn build(self) -> Result<ThreadPool, std::convert::Infallible> {
            Ok(ThreadPool)
        }
    }

    #[repr(transparent)]
    pub struct SeqIter<I>(I);

    pub struct MapInit<I, T, F> {
        iter: I,
        state: T,
        op: F,
    }

    impl<I, T, R, F> Iterator for MapInit<I, T, F>
    where
        I: Iterator,
        F: FnMut(&mut T, I::Item) -> R,
    {
        type Item = R;

        #[inline]
        fn next(&mut self) -> Option<Self::Item> {
            self.iter
                .next()
                .map(|item| (self.op)(&mut self.state, item))
        }

        #[inline]
        fn size_hint(&self) -> (usize, Option<usize>) {
            self.iter.size_hint()
        }
    }

    impl<I: Iterator> SeqIter<I> {
        #[inline]
        pub fn enumerate(self) -> SeqIter<Enumerate<I>> {
            SeqIter(self.0.enumerate())
        }

        #[inline]
        pub fn zip<J: Iterator>(self, other: SeqIter<J>) -> SeqIter<Zip<I, J>> {
            SeqIter(self.0.zip(other.0))
        }

        #[inline]
        pub fn skip(self, n: usize) -> SeqIter<Skip<I>> {
            SeqIter(self.0.skip(n))
        }

        #[inline]
        pub fn take(self, n: usize) -> SeqIter<Take<I>> {
            SeqIter(self.0.take(n))
        }

        #[inline]
        pub fn map<B, F>(self, f: F) -> SeqIter<Map<I, F>>
        where
            F: FnMut(I::Item) -> B,
        {
            SeqIter(self.0.map(f))
        }

        #[inline]
        pub fn filter_map<B, F>(self, f: F) -> SeqIter<FilterMap<I, F>>
        where
            F: FnMut(I::Item) -> Option<B>,
        {
            SeqIter(self.0.filter_map(f))
        }

        #[inline]
        pub fn flatten(self) -> SeqIter<Flatten<I>>
        where
            I::Item: IntoIterator,
        {
            SeqIter(self.0.flatten())
        }

        #[inline]
        pub fn flat_map_iter<U, F>(self, f: F) -> SeqIter<FlatMap<I, U, F>>
        where
            U: IntoIterator,
            F: FnMut(I::Item) -> U,
        {
            SeqIter(self.0.flat_map(f))
        }

        #[inline]
        pub fn map_init<T, R, INIT, F>(self, init: INIT, op: F) -> SeqIter<MapInit<I, T, F>>
        where
            INIT: FnOnce() -> T,
            F: FnMut(&mut T, I::Item) -> R,
        {
            SeqIter(MapInit {
                iter: self.0,
                state: init(),
                op,
            })
        }

        #[inline]
        pub fn for_each<F>(self, f: F)
        where
            F: FnMut(I::Item),
        {
            self.0.for_each(f);
        }

        #[inline]
        pub fn for_each_init<T, INIT, F>(self, init: INIT, mut op: F)
        where
            INIT: FnOnce() -> T,
            F: FnMut(&mut T, I::Item),
        {
            let mut state = init();
            for item in self.0 {
                op(&mut state, item);
            }
        }

        #[inline]
        pub fn reduce<ID, OP>(self, identity: ID, op: OP) -> I::Item
        where
            ID: FnOnce() -> I::Item,
            OP: FnMut(I::Item, I::Item) -> I::Item,
        {
            self.0.fold(identity(), op)
        }

        #[inline]
        pub fn collect<C>(self) -> C
        where
            C: FromIterator<I::Item>,
        {
            self.0.collect()
        }
    }

    pub mod prelude {
        use super::SeqIter;

        pub trait ParallelSlice<T> {
            fn par_iter(&self) -> SeqIter<std::slice::Iter<'_, T>>;
            fn par_chunks(&self, chunk_size: usize) -> SeqIter<std::slice::Chunks<'_, T>>;
        }

        impl<T> ParallelSlice<T> for [T] {
            #[inline]
            fn par_iter(&self) -> SeqIter<std::slice::Iter<'_, T>> {
                SeqIter(self.iter())
            }

            #[inline]
            fn par_chunks(&self, chunk_size: usize) -> SeqIter<std::slice::Chunks<'_, T>> {
                SeqIter(self.chunks(chunk_size))
            }
        }

        pub trait ParallelSliceMut<T> {
            fn par_iter_mut(&mut self) -> SeqIter<std::slice::IterMut<'_, T>>;
            fn par_chunks_mut(
                &mut self,
                chunk_size: usize,
            ) -> SeqIter<std::slice::ChunksMut<'_, T>>;
        }

        impl<T> ParallelSliceMut<T> for [T] {
            #[inline]
            fn par_iter_mut(&mut self) -> SeqIter<std::slice::IterMut<'_, T>> {
                SeqIter(self.iter_mut())
            }

            #[inline]
            fn par_chunks_mut(
                &mut self,
                chunk_size: usize,
            ) -> SeqIter<std::slice::ChunksMut<'_, T>> {
                SeqIter(self.chunks_mut(chunk_size))
            }
        }

        pub trait IntoParallelIterator: Sized {
            type Iter: Iterator;
            fn into_par_iter(self) -> SeqIter<Self::Iter>;
        }

        impl<T: IntoIterator> IntoParallelIterator for T {
            type Iter = T::IntoIter;

            #[inline]
            fn into_par_iter(self) -> SeqIter<Self::Iter> {
                SeqIter(self.into_iter())
            }
        }
    }
}

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
pub use sequential::{current_num_threads, join, prelude, ThreadPool, ThreadPoolBuilder};
