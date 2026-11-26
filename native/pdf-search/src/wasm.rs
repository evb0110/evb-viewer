use evb_native_support::{
    wasm_request_allocation::{
        WasmRequestAllocation, WASM_MAX_BUFFER_BYTES, WASM_REQUEST_ALLOCATION_ABI_VERSION,
    },
    NativeErrorCode, NativeErrorEnvelope,
};
use std::{cell::RefCell, slice};

use crate::handle_wasm_request;

thread_local! {
    static REQUEST_ALLOCATION: WasmRequestAllocation = const { WasmRequestAllocation::new(WASM_MAX_BUFFER_BYTES) };
    static LAST_OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn evb_wasm_request_allocation_abi_version() -> u32 {
    WASM_REQUEST_ALLOCATION_ABI_VERSION
}

#[no_mangle]
pub extern "C" fn evb_pdf_search_alloc(len: usize) -> *mut u8 {
    REQUEST_ALLOCATION.with(|allocation| allocation.allocate(len))
}

/// Frees the active request allocation returned by `evb_pdf_search_alloc`.
///
/// # Safety
/// `pointer` and `byte_length` must match the currently live allocation from
/// `evb_pdf_search_alloc`.
#[no_mangle]
pub unsafe extern "C" fn evb_pdf_search_free(pointer: *mut u8, byte_length: usize) {
    REQUEST_ALLOCATION.with(|allocation| allocation.free(pointer, byte_length));
}

/// Runs a binary-framed search request stored in the active allocation.
///
/// # Safety
/// `request_pointer` must point to `request_len` initialized bytes returned by
/// `evb_pdf_search_alloc`.
#[no_mangle]
pub unsafe extern "C" fn evb_pdf_search_run(request_pointer: *const u8, request_len: usize) -> i32 {
    clear_last_result();
    if request_pointer.is_null() || request_len == 0 || request_len > WASM_MAX_BUFFER_BYTES {
        set_error_envelope(NativeErrorEnvelope {
            code: NativeErrorCode::TooLarge,
            message: "PDF search WASM request exceeds the admission ceiling".to_string(),
        });
        return -1;
    }
    if !REQUEST_ALLOCATION.with(|allocation| allocation.matches(request_pointer, request_len)) {
        set_error_envelope(NativeErrorEnvelope {
            code: NativeErrorCode::InvalidRequest,
            message: "PDF search WASM request does not match the live allocation".to_string(),
        });
        return -1;
    }
    let request = slice::from_raw_parts(request_pointer, request_len);
    match std::panic::catch_unwind(|| handle_wasm_request(request)) {
        Ok(Ok(output)) => {
            LAST_OUTPUT.with(|slot| *slot.borrow_mut() = output);
            0
        }
        Ok(Err(error)) => {
            set_error_envelope(NativeErrorEnvelope::from_error(&error));
            -1
        }
        Err(payload) => {
            set_error_envelope(NativeErrorEnvelope::from_panic(payload));
            -1
        }
    }
}

#[no_mangle]
pub extern "C" fn evb_pdf_search_output_ptr() -> *const u8 {
    LAST_OUTPUT.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn evb_pdf_search_output_len() -> usize {
    LAST_OUTPUT.with(|slot| slot.borrow().len())
}

#[no_mangle]
pub extern "C" fn evb_pdf_search_error_ptr() -> *const u8 {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn evb_pdf_search_error_len() -> usize {
    LAST_ERROR.with(|slot| slot.borrow().len())
}

fn set_error_envelope(envelope: NativeErrorEnvelope) {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = envelope.to_json().into_bytes());
}

fn clear_last_result() {
    LAST_OUTPUT.with(|slot| *slot.borrow_mut() = Vec::new());
    LAST_ERROR.with(|slot| slot.borrow_mut().clear());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocator_requires_one_exact_live_pointer_and_length() {
        assert_eq!(
            evb_wasm_request_allocation_abi_version(),
            WASM_REQUEST_ALLOCATION_ABI_VERSION
        );
        assert!(evb_pdf_search_alloc(0).is_null());
        assert!(evb_pdf_search_alloc(WASM_MAX_BUFFER_BYTES + 1).is_null());

        let pointer = evb_pdf_search_alloc(17);
        assert!(!pointer.is_null());
        assert!(evb_pdf_search_alloc(1).is_null());

        let status = unsafe { evb_pdf_search_run(pointer, 16) };
        assert_eq!(status, -1);
        let envelope = LAST_ERROR.with(|slot| String::from_utf8(slot.borrow().clone()).unwrap());
        assert_eq!(
            envelope,
            r#"{"code":"invalid-request","message":"PDF search WASM request does not match the live allocation"}"#
        );

        unsafe { evb_pdf_search_free(pointer, 16) };
        assert!(evb_pdf_search_alloc(1).is_null());
        unsafe { evb_pdf_search_free(pointer, 17) };
        let next_pointer = evb_pdf_search_alloc(1);
        assert!(!next_pointer.is_null());
        unsafe { evb_pdf_search_free(next_pointer, 1) };
    }

    #[test]
    fn clearing_output_releases_its_allocation() {
        LAST_OUTPUT.with(|slot| {
            *slot.borrow_mut() = Vec::with_capacity(1024);
        });
        clear_last_result();
        LAST_OUTPUT.with(|slot| {
            assert_eq!(slot.borrow().capacity(), 0);
        });
    }
}
