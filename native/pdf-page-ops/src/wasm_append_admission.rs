//! Desktop's open-time append admission for the browser. A browser working
//! copy runs it before anything reads object numbers from the PDF, and asks
//! the browser qpdf engine for desktop's rewrite when it answers repairable.
//! The input arrives in the request allocation `evb_pdf_page_ops_alloc` hands
//! out; the caller frees it.

use crate::{append_admission_of_bytes, wasm::REQUEST_ALLOCATION, AppendAdmission};

pub const APPEND_ADMISSION_APPENDABLE: i32 = 0;
pub const APPEND_ADMISSION_REPAIRABLE: i32 = 1;
pub const APPEND_ADMISSION_LIMITED: i32 = 2;
pub const APPEND_ADMISSION_UNVERIFIED: i32 = 3;
/// The admission itself failed; the PDF was not judged.
pub const APPEND_ADMISSION_FAILED: i32 = -1;

/// # Safety
///
/// `pointer` and `len` must be the live request allocation.
#[no_mangle]
pub unsafe extern "C" fn evb_pdf_page_ops_append_admission(pointer: *const u8, len: usize) -> i32 {
    if len == 0 || !REQUEST_ALLOCATION.with(|allocation| allocation.matches(pointer, len)) {
        return APPEND_ADMISSION_FAILED;
    }
    let bytes = unsafe { std::slice::from_raw_parts(pointer, len) };
    match std::panic::catch_unwind(|| append_admission_of_bytes(bytes)) {
        Ok(Ok(AppendAdmission::Appendable)) => APPEND_ADMISSION_APPENDABLE,
        Ok(Ok(AppendAdmission::Repairable(_))) => APPEND_ADMISSION_REPAIRABLE,
        Ok(Ok(AppendAdmission::Limited(_))) => APPEND_ADMISSION_LIMITED,
        Ok(Ok(AppendAdmission::Unverified(_))) => APPEND_ADMISSION_UNVERIFIED,
        Ok(Err(_)) | Err(_) => APPEND_ADMISSION_FAILED,
    }
}
