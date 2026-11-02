use std::{
    alloc::{alloc, dealloc, Layout},
    cell::RefCell,
    ptr::NonNull,
};

pub const WASM_REQUEST_ALLOCATION_ABI_VERSION: u32 = 1;

/// The largest single wasm32 Rust allocation (`isize::MAX` there): one engine
/// request or one framed response. The 4 GiB address space must also hold the
/// engine's working memory, so a buffer near this ceiling fails as an
/// allocation failure rather than at a policy.
pub const WASM_MAX_BUFFER_BYTES: usize = 0x7fff_ffff;

#[derive(Clone, Copy)]
struct LiveAllocation {
    pointer: NonNull<u8>,
    layout: Layout,
}

/// Owns at most one request allocation for one single-threaded WASM module instance.
///
/// `NonNull` keeps this type neither `Send` nor `Sync`. The `RefCell` borrow checks
/// make same-thread reentrant access fail closed; they do not provide thread synchronization.
pub struct WasmRequestAllocation {
    live: RefCell<Option<LiveAllocation>>,
    max_bytes: usize,
}

impl WasmRequestAllocation {
    pub const fn new(max_bytes: usize) -> Self {
        Self {
            live: RefCell::new(None),
            max_bytes,
        }
    }

    pub fn allocate(&self, byte_length: usize) -> *mut u8 {
        let Some(layout) = self.layout(byte_length) else {
            return std::ptr::null_mut();
        };
        let Ok(mut live) = self.live.try_borrow_mut() else {
            return std::ptr::null_mut();
        };
        if live.is_some() {
            return std::ptr::null_mut();
        }

        let Some(pointer) = NonNull::new(unsafe { alloc(layout) }) else {
            return std::ptr::null_mut();
        };
        *live = Some(LiveAllocation { pointer, layout });
        pointer.as_ptr()
    }

    pub fn matches(&self, pointer: *const u8, byte_length: usize) -> bool {
        let Ok(live) = self.live.try_borrow() else {
            return false;
        };
        live.as_ref().is_some_and(|allocation| {
            allocation.pointer.as_ptr().cast_const() == pointer
                && allocation.layout.size() == byte_length
        })
    }

    pub fn free(&self, pointer: *mut u8, byte_length: usize) -> bool {
        let Ok(mut live) = self.live.try_borrow_mut() else {
            return false;
        };
        let Some(allocation) = live.as_ref() else {
            return false;
        };
        if allocation.pointer.as_ptr() != pointer || allocation.layout.size() != byte_length {
            return false;
        }

        let allocation = live.take().expect("checked live WASM request allocation");
        unsafe { dealloc(allocation.pointer.as_ptr(), allocation.layout) };
        true
    }

    fn layout(&self, byte_length: usize) -> Option<Layout> {
        if byte_length == 0 || byte_length > self.max_bytes {
            return None;
        }
        Layout::array::<u8>(byte_length).ok()
    }
}

impl Drop for WasmRequestAllocation {
    fn drop(&mut self) {
        let Some(allocation) = self.live.get_mut().take() else {
            return;
        };
        unsafe { dealloc(allocation.pointer.as_ptr(), allocation.layout) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_the_exact_layout_until_the_matching_free() {
        let allocation = WasmRequestAllocation::new(4096);

        for byte_length in [1, 3, 17, 257, 1021, 4093] {
            let pointer = allocation.allocate(byte_length);
            assert!(!pointer.is_null());
            assert!(allocation.matches(pointer, byte_length));
            assert!(!allocation.matches(pointer, byte_length - 1));
            assert!(allocation.allocate(1).is_null());
            assert!(!allocation.free(pointer.wrapping_add(1), byte_length));
            assert!(!allocation.free(pointer, byte_length - 1));
            assert!(allocation.matches(pointer, byte_length));

            unsafe {
                std::ptr::write_bytes(pointer, 0xa5, byte_length);
                assert_eq!(*pointer.add(byte_length - 1), 0xa5);
            }
            assert!(allocation.free(pointer, byte_length));
            assert!(!allocation.matches(pointer, byte_length));
            assert!(!allocation.free(pointer, byte_length));
        }
    }

    #[test]
    fn rejects_zero_oversized_and_layout_overflow_lengths() {
        let allocation = WasmRequestAllocation::new(usize::MAX);

        assert!(allocation.allocate(0).is_null());
        assert!(allocation.allocate(usize::MAX).is_null());
        assert!(!allocation.matches(std::ptr::NonNull::<u8>::dangling().as_ptr(), 1));
    }

    #[test]
    fn drop_releases_a_live_allocation_without_explicit_free() {
        assert!(std::mem::needs_drop::<WasmRequestAllocation>());
        let allocation = WasmRequestAllocation::new(4096);
        let pointer = allocation.allocate(257);
        assert!(!pointer.is_null());
        assert!(allocation.matches(pointer, 257));

        drop(allocation);
    }
}
