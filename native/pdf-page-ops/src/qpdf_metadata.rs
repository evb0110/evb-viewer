//! Read-only object projections through the bundled qpdf library. Unlike its
//! JSON exporter, the C object interface resolves only objects a consumer needs.

use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum QpdfMetadataPurpose {
    Geometry,
    Annotations,
    Catalog,
    Conformance,
    AnnotationIndex,
}

/// None means only that the supplied qpdf executable has no adjacent library.
/// A present but unusable library, or an unreadable PDF, is an error.
/// The boolean reports bounded qpdf warnings to the load-policy owner.
pub(crate) fn load_qpdf_metadata_pdf_path(
    path: &Path,
    qpdf_path: &Path,
    purpose: QpdfMetadataPurpose,
) -> Result<Option<(IncrementalDocument, bool)>> {
    #[cfg(not(target_family = "wasm"))]
    {
        platform::load(path, qpdf_path, purpose)
    }
    #[cfg(target_family = "wasm")]
    {
        let _ = (path, qpdf_path, purpose);
        Ok(None)
    }
}

/// The retained-memory estimate of one loaded object, as the qpdf JSON reader
/// charges it.
pub(crate) fn retained_cost(object: &Object) -> Result<usize> {
    let mut pending = vec![(object, 0)];
    let mut elements = 0usize;
    let mut bytes = 0usize;
    while let Some((object, depth)) = pending.pop() {
        elements += 1;
        if elements > MAX_QPDF_OBJECT_ELEMENTS || depth > MAX_PDF_STRUCTURAL_NESTING {
            return Err(resource_limited(
                "Selected qpdf object exceeds its element or nesting ceiling",
            ));
        }
        bytes = bytes
            .checked_add(QPDF_ESTIMATED_BYTES_PER_VALUE)
            .ok_or_else(|| resource_limited("PDF metadata retained size overflow"))?;
        match object {
            Object::Name(value) | Object::String(value, _) => {
                bytes = bytes
                    .checked_add(value.len())
                    .ok_or_else(|| resource_limited("PDF metadata retained size overflow"))?;
            }
            Object::Array(values) => pending.extend(values.iter().map(|value| (value, depth + 1))),
            Object::Dictionary(dict) => {
                for (key, value) in dict.iter() {
                    bytes = bytes
                        .checked_add(key.len())
                        .ok_or_else(|| resource_limited("PDF metadata retained size overflow"))?;
                    pending.push((value, depth + 1));
                }
            }
            Object::Stream(stream) => {
                for (key, value) in stream.dict.iter() {
                    bytes = bytes
                        .checked_add(key.len())
                        .ok_or_else(|| resource_limited("PDF metadata retained size overflow"))?;
                    pending.push((value, depth + 1));
                }
            }
            _ => {}
        }
    }
    Ok(bytes)
}

fn resource_limited(message: &str) -> Box<dyn Error> {
    domain_error(NativeErrorCode::TooLarge, message)
}

#[cfg(not(target_family = "wasm"))]
mod platform {
    use super::*;
    use crate::incremental_document::{
        MAX_QPDF_DIAGNOSTIC_BYTES, MAX_QPDF_OBJECT_BYTES, MAX_QPDF_OBJECT_ELEMENTS,
        MAX_QPDF_RETAINED_STRUCTURE_BYTES,
    };
    use std::{
        cell::Cell,
        collections::VecDeque,
        ffi::{c_char, c_int, c_uint, c_void, CStr, CString},
        io::BufRead,
    };

    type Handle = c_uint;
    type Data = *mut c_void;
    const MAX_XREF_BYTES: usize = 64 * 1024 * 1024;

    fn corrupt(message: impl Into<String>) -> Box<dyn Error> {
        domain_error(NativeErrorCode::CorruptXref, message)
    }

    fn limited(message: impl Into<String>) -> Box<dyn Error> {
        domain_error(NativeErrorCode::TooLarge, message)
    }

    fn unavailable(message: impl Into<String>) -> Box<dyn Error> {
        domain_error(NativeErrorCode::NativeFailure, message)
    }

    struct Library(Data);

    impl Library {
        fn open(path: &Path) -> std::io::Result<Self> {
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStrExt;
                let path = CString::new(path.as_os_str().as_bytes())?;
                let handle =
                    unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL) };
                if handle.is_null() {
                    Err(Self::last_error())
                } else {
                    Ok(Self(handle))
                }
            }
            #[cfg(windows)]
            {
                use std::os::windows::ffi::OsStrExt;
                let mut path = path.as_os_str().encode_wide().collect::<Vec<_>>();
                if path.contains(&0) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "Library path contains NUL",
                    ));
                }
                path.push(0);
                let mut previous = 0;
                let changed = unsafe { loader_os::SetThreadErrorMode(1, &mut previous) } != 0;
                let handle = unsafe {
                    loader_os::LoadLibraryExW(path.as_ptr(), std::ptr::null_mut(), 0x100 | 0x1000)
                };
                // Capture the load error before restoring thread-local mode.
                let result = if handle.is_null() {
                    Err(Self::last_error())
                } else {
                    Ok(Self(handle))
                };
                if changed && previous != 1 {
                    unsafe { loader_os::SetThreadErrorMode(previous, std::ptr::null_mut()) };
                }
                result
            }
        }

        unsafe fn symbol<T: Copy>(&self, name: &CStr) -> std::io::Result<T> {
            const { assert!(std::mem::size_of::<T>() == std::mem::size_of::<Data>()) };
            #[cfg(unix)]
            let pointer = unsafe {
                libc::dlerror();
                libc::dlsym(self.0, name.as_ptr())
            };
            #[cfg(windows)]
            let pointer = unsafe { loader_os::GetProcAddress(self.0, name.as_ptr()) };
            if pointer.is_null() {
                Err(Self::last_error())
            } else {
                // Api supplies only the declared qpdf C function-pointer types.
                Ok(unsafe { std::mem::transmute_copy(&pointer) })
            }
        }

        fn last_error() -> std::io::Error {
            #[cfg(unix)]
            {
                let pointer = unsafe { libc::dlerror() };
                std::io::Error::other(if pointer.is_null() {
                    "Dynamic library operation failed".to_string()
                } else {
                    unsafe { CStr::from_ptr(pointer) }
                        .to_string_lossy()
                        .into_owned()
                })
            }
            #[cfg(windows)]
            std::io::Error::last_os_error()
        }
    }

    impl Drop for Library {
        fn drop(&mut self) {
            #[cfg(unix)]
            unsafe {
                libc::dlclose(self.0)
            };
            #[cfg(windows)]
            unsafe {
                loader_os::FreeLibrary(self.0)
            };
        }
    }

    #[cfg(windows)]
    mod loader_os {
        use super::*;

        #[link(name = "kernel32")]
        unsafe extern "system" {
            pub(super) fn LoadLibraryExW(path: *const u16, file: Data, flags: u32) -> Data;
            pub(super) fn GetProcAddress(library: Data, name: *const c_char) -> Data;
            pub(super) fn FreeLibrary(library: Data) -> c_int;
            pub(super) fn SetThreadErrorMode(mode: u32, previous: *mut u32) -> c_int;
        }
    }

    // All functions are the stable qpdf C interface from qpdf-c.h. The library
    // stays alive until after its data and handles have been released.
    struct Api {
        init: unsafe extern "C" fn() -> Data,
        cleanup: unsafe extern "C" fn(*mut Data),
        read: unsafe extern "C" fn(Data, *const c_char, *const c_char) -> c_int,
        silence_errors: unsafe extern "C" fn(Data),
        suppress_warnings: unsafe extern "C" fn(Data, c_int),
        attempt_recovery: unsafe extern "C" fn(Data, c_int),
        has_error: unsafe extern "C" fn(Data) -> c_int,
        get_error: unsafe extern "C" fn(Data) -> Data,
        error_text: unsafe extern "C" fn(Data, Data) -> *const c_char,
        error_code: unsafe extern "C" fn(Data, Data) -> c_int,
        more_warnings: unsafe extern "C" fn(Data) -> c_int,
        next_warning: unsafe extern "C" fn(Data) -> Data,
        version: unsafe extern "C" fn(Data) -> *const c_char,
        trailer: unsafe extern "C" fn(Data) -> Handle,
        object: unsafe extern "C" fn(Data, c_int, c_int) -> Handle,
        is_stream: unsafe extern "C" fn(Data, Handle) -> c_int,
        object_type: unsafe extern "C" fn(Data, Handle) -> c_int,
        is_indirect: unsafe extern "C" fn(Data, Handle) -> c_int,
        name_equals: unsafe extern "C" fn(Data, Handle, *const c_char) -> c_int,
        has_key: unsafe extern "C" fn(Data, Handle, *const c_char) -> c_int,
        get_key: unsafe extern "C" fn(Data, Handle, *const c_char) -> Handle,
        object_id: unsafe extern "C" fn(Data, Handle) -> c_int,
        generation: unsafe extern "C" fn(Data, Handle) -> c_int,
        boolean: unsafe extern "C" fn(Data, Handle) -> c_int,
        integer: unsafe extern "C" fn(Data, Handle, *mut i64) -> c_int,
        real: unsafe extern "C" fn(Data, Handle, *mut *const c_char, *mut usize) -> c_int,
        name: unsafe extern "C" fn(Data, Handle, *mut *const c_char, *mut usize) -> c_int,
        string: unsafe extern "C" fn(Data, Handle, *mut usize) -> *const c_char,
        array_length: unsafe extern "C" fn(Data, Handle) -> c_int,
        array_item: unsafe extern "C" fn(Data, Handle, c_int) -> Handle,
        begin_keys: unsafe extern "C" fn(Data, Handle),
        more_keys: unsafe extern "C" fn(Data) -> c_int,
        next_key: unsafe extern "C" fn(Data) -> *const c_char,
        dictionary: unsafe extern "C" fn(Data, Handle) -> Handle,
        release: unsafe extern "C" fn(Data, Handle),
        page_count: unsafe extern "C" fn(Data) -> c_int,
        page: unsafe extern "C" fn(Data, usize) -> Handle,
        new_null: unsafe extern "C" fn(Data) -> Handle,
        make_indirect: unsafe extern "C" fn(Data, Handle) -> Handle,
        _library: Library,
    }

    impl Api {
        fn open(path: &Path) -> Result<Self> {
            // The complete path is owned by the bundled executable's family;
            // no environment or system library search chooses libqpdf.
            let library = Library::open(path).map_err(|error| {
                unavailable(format!("Cannot load bundled qpdf library: {error}"))
            })?;
            macro_rules! symbol {
                ($name:literal) => {
                    unsafe { library.symbol($name) }.map_err(|error| {
                        unavailable(format!(
                            "Bundled qpdf library is missing {}: {error}",
                            $name.to_string_lossy()
                        ))
                    })?
                };
            }
            Ok(Self {
                init: symbol!(c"qpdf_init"),
                cleanup: symbol!(c"qpdf_cleanup"),
                read: symbol!(c"qpdf_read"),
                silence_errors: symbol!(c"qpdf_silence_errors"),
                suppress_warnings: symbol!(c"qpdf_set_suppress_warnings"),
                attempt_recovery: symbol!(c"qpdf_set_attempt_recovery"),
                has_error: symbol!(c"qpdf_has_error"),
                get_error: symbol!(c"qpdf_get_error"),
                error_text: symbol!(c"qpdf_get_error_full_text"),
                error_code: symbol!(c"qpdf_get_error_code"),
                more_warnings: symbol!(c"qpdf_more_warnings"),
                next_warning: symbol!(c"qpdf_next_warning"),
                version: symbol!(c"qpdf_get_pdf_version"),
                trailer: symbol!(c"qpdf_get_trailer"),
                object: symbol!(c"qpdf_get_object_by_id"),
                is_stream: symbol!(c"qpdf_oh_is_stream"),
                object_type: symbol!(c"qpdf_oh_get_type_code"),
                is_indirect: symbol!(c"qpdf_oh_is_indirect"),
                name_equals: symbol!(c"qpdf_oh_is_name_and_equals"),
                has_key: symbol!(c"qpdf_oh_has_key"),
                get_key: symbol!(c"qpdf_oh_get_key"),
                object_id: symbol!(c"qpdf_oh_get_object_id"),
                generation: symbol!(c"qpdf_oh_get_generation"),
                boolean: symbol!(c"qpdf_oh_get_bool_value"),
                integer: symbol!(c"qpdf_oh_get_value_as_longlong"),
                real: symbol!(c"qpdf_oh_get_value_as_real"),
                name: symbol!(c"qpdf_oh_get_value_as_name"),
                string: symbol!(c"qpdf_oh_get_binary_string_value"),
                array_length: symbol!(c"qpdf_oh_get_array_n_items"),
                array_item: symbol!(c"qpdf_oh_get_array_item"),
                begin_keys: symbol!(c"qpdf_oh_begin_dict_key_iter"),
                more_keys: symbol!(c"qpdf_oh_dict_more_keys"),
                next_key: symbol!(c"qpdf_oh_dict_next_key"),
                dictionary: symbol!(c"qpdf_oh_get_dict"),
                release: symbol!(c"qpdf_oh_release"),
                page_count: symbol!(c"qpdf_get_num_pages"),
                page: symbol!(c"qpdf_get_page_n"),
                new_null: symbol!(c"qpdf_oh_new_null"),
                make_indirect: symbol!(c"qpdf_make_indirect_object"),
                _library: library,
            })
        }
    }

    struct Reader {
        api: Api,
        data: Data,
        purpose: QpdfMetadataPurpose,
        diagnostic_bytes: Cell<usize>,
    }

    impl Drop for Reader {
        fn drop(&mut self) {
            unsafe { (self.api.cleanup)(&mut self.data) };
        }
    }

    struct ObjectHandle<'a> {
        reader: &'a Reader,
        value: Handle,
    }

    impl Drop for ObjectHandle<'_> {
        fn drop(&mut self) {
            unsafe { (self.reader.api.release)(self.reader.data, self.value) };
        }
    }

    impl Reader {
        fn open(library: &Path, path: &Path, purpose: QpdfMetadataPurpose) -> Result<Self> {
            let api = Api::open(library)?;
            let data = unsafe { (api.init)() };
            if data.is_null() {
                return Err(corrupt("Bundled qpdf library could not create a reader"));
            }
            let reader = Self {
                api,
                data,
                purpose,
                diagnostic_bytes: Cell::new(0),
            };
            unsafe {
                (reader.api.silence_errors)(data);
                (reader.api.suppress_warnings)(data, 1);
                (reader.api.attempt_recovery)(
                    data,
                    c_int::from(purpose == QpdfMetadataPurpose::Conformance),
                );
            }
            #[cfg(windows)]
            let path_bytes = path
                .to_str()
                .ok_or_else(|| {
                    domain_error(
                        NativeErrorCode::InvalidRequest,
                        "PDF path is not valid Unicode",
                    )
                })?
                .as_bytes();
            #[cfg(not(windows))]
            let path_bytes = path.as_os_str().as_encoded_bytes();
            let path = CString::new(path_bytes)
                .map_err(|_| io_domain_error(std::io::Error::other("PDF path contains NUL")))?;
            let status = unsafe { (reader.api.read)(data, path.as_ptr(), std::ptr::null()) };
            reader.checkpoint()?;
            if status & 2 != 0 {
                return Err(corrupt("Bundled qpdf could not read the PDF"));
            }
            Ok(reader)
        }

        fn check(&self) -> Result<()> {
            if unsafe { (self.api.has_error)(self.data) } == 0 {
                return Ok(());
            }
            let error = unsafe { (self.api.get_error)(self.data) };
            let code = unsafe { (self.api.error_code)(self.data, error) };
            let text = unsafe { (self.api.error_text)(self.data, error) };
            let message = if text.is_null() {
                "Bundled qpdf metadata read failed".to_string()
            } else {
                unsafe { CStr::from_ptr(text) }
                    .to_string_lossy()
                    .into_owned()
            };
            Err(domain_error(
                match code {
                    2 => NativeErrorCode::Io,
                    3 => NativeErrorCode::UnsupportedFilter,
                    4 => NativeErrorCode::NeedsPassword,
                    _ => NativeErrorCode::CorruptXref,
                },
                message,
            ))
        }

        fn checkpoint(&self) -> Result<()> {
            self.check()?;
            // qpdf retains warnings until retrieved. Drain at object boundaries
            // using the same byte ceiling as the CLI's diagnostic file.
            while unsafe { (self.api.more_warnings)(self.data) } != 0 {
                let warning = unsafe { (self.api.next_warning)(self.data) };
                let pointer = unsafe { (self.api.error_text)(self.data, warning) };
                if pointer.is_null() {
                    return Err(corrupt("Bundled qpdf returned an invalid warning"));
                }
                let bytes = unsafe { CStr::from_ptr(pointer) }.to_bytes().len();
                let total = self
                    .diagnostic_bytes
                    .get()
                    .checked_add(bytes)
                    .and_then(|bytes| bytes.checked_add(10))
                    .ok_or_else(|| limited("qpdf diagnostic byte count overflow"))?;
                if total > MAX_QPDF_DIAGNOSTIC_BYTES {
                    return Err(limited("qpdf diagnostics exceeded their resource limit"));
                }
                self.diagnostic_bytes.set(total);
            }
            Ok(())
        }

        fn handle(&self, value: Handle) -> Result<ObjectHandle<'_>> {
            self.check()?;
            if value == 0 {
                return Err(corrupt(
                    "Bundled qpdf returned an uninitialized object handle",
                ));
            }
            Ok(ObjectHandle {
                reader: self,
                value,
            })
        }

        fn version(&self) -> Result<String> {
            let version = unsafe { (self.api.version)(self.data) };
            self.check()?;
            if version.is_null() {
                return Err(corrupt("Bundled qpdf did not report the PDF version"));
            }
            Ok(unsafe { CStr::from_ptr(version) }.to_str()?.to_string())
        }

        fn trailer(&self) -> Result<Dictionary> {
            let handle = self.handle(unsafe { (self.api.trailer)(self.data) })?;
            let object = self.convert(&handle, Context::Value)?;
            self.checkpoint()?;
            object.as_dict().cloned().map_err(Into::into)
        }

        fn object(&self, id: ObjectId, context: Context) -> Result<Object> {
            let handle = self.object_handle(id)?;
            let object = self.convert(&handle, context)?;
            self.checkpoint()?;
            Ok(object)
        }

        /// Physical page order from qpdf's page-tree walk, as `--show-pages`
        /// reports it.
        fn page_ids(&self) -> Result<Vec<ObjectId>> {
            let count = unsafe { (self.api.page_count)(self.data) };
            self.checkpoint()?;
            let count = usize::try_from(count)
                .map_err(|_| corrupt("Bundled qpdf could not walk the page tree"))?;
            if count > crate::load_policy::MAX_PATH_INPUT_PDF_PAGES {
                return Err(limited("PDF page count exceeds the native path-load limit"));
            }
            let mut ids = Vec::with_capacity(count);
            for index in 0..count {
                let page = self.handle(unsafe { (self.api.page)(self.data, index) })?;
                let number = unsafe { (self.api.object_id)(self.data, page.value) };
                let generation = unsafe { (self.api.generation)(self.data, page.value) };
                self.check()?;
                ids.push((u32::try_from(number)?, u16::try_from(generation)?));
            }
            self.checkpoint()?;
            Ok(ids)
        }

        /// The highest object number qpdf knows from the cross-reference
        /// data, the JSON writer's `maxobjectid`. qpdf numbers a new indirect
        /// object one above it; the object stays in this reader's memory.
        fn max_object_number(&self) -> Result<u32> {
            let null = self.handle(unsafe { (self.api.new_null)(self.data) })?;
            let fresh = self.handle(unsafe { (self.api.make_indirect)(self.data, null.value) })?;
            let number = unsafe { (self.api.object_id)(self.data, fresh.value) };
            self.check()?;
            u32::try_from(number)
                .ok()
                .and_then(|number| number.checked_sub(1))
                .ok_or_else(|| corrupt("Bundled qpdf returned an invalid object number"))
        }

        fn object_handle(&self, id: ObjectId) -> Result<ObjectHandle<'_>> {
            let number = c_int::try_from(id.0)
                .map_err(|_| limited("PDF object number exceeds qpdf's supported range"))?;
            self.handle(unsafe { (self.api.object)(self.data, number, id.1.into()) })
        }

        fn signature_dictionary(&self, handle: &ObjectHandle<'_>) -> Result<bool> {
            let kind = self.handle(unsafe {
                (self.api.get_key)(self.data, handle.value, c"/Type".as_ptr())
            })?;
            let direct = unsafe { (self.api.is_indirect)(self.data, kind.value) } == 0;
            let signature = direct
                && unsafe { (self.api.name_equals)(self.data, kind.value, c"/Sig".as_ptr()) } != 0;
            let ranges =
                unsafe { (self.api.has_key)(self.data, handle.value, c"/ByteRange".as_ptr()) } != 0;
            let contents =
                unsafe { (self.api.has_key)(self.data, handle.value, c"/Contents".as_ptr()) } != 0;
            self.check()?;
            Ok(signature || (ranges && contents))
        }

        fn is_signature(&self, id: ObjectId) -> Result<bool> {
            let object = self.object_handle(id)?;
            let kind = unsafe { (self.api.object_type)(self.data, object.value) };
            self.check()?;
            if kind != 9 && kind != 10 {
                return Ok(false);
            }
            let stream_dictionary;
            let dictionary = if kind == 10 {
                stream_dictionary =
                    self.handle(unsafe { (self.api.dictionary)(self.data, object.value) })?;
                &stream_dictionary
            } else {
                &object
            };
            if self.signature_dictionary(dictionary)? {
                return Ok(true);
            }
            let value = self.handle(unsafe {
                (self.api.get_key)(self.data, dictionary.value, c"/V".as_ptr())
            })?;
            let kind = unsafe { (self.api.object_type)(self.data, value.value) };
            self.check()?;
            if kind == 9 {
                self.signature_dictionary(&value)
            } else {
                Ok(false)
            }
        }

        /// The typed traversal admits each direct value against the object's
        /// element, nesting and byte ceilings before it copies the value.
        fn convert(&self, handle: &ObjectHandle<'_>, context: Context) -> Result<Object> {
            let is_stream = unsafe { (self.api.is_stream)(self.data, handle.value) } != 0;
            self.check()?;
            if !is_stream {
                return self.typed(handle.value, true, 0, &mut 0, &mut 0, context);
            }
            let dictionary =
                self.handle(unsafe { (self.api.dictionary)(self.data, handle.value) })?;
            let object = self.typed(dictionary.value, true, 0, &mut 0, &mut 0, Context::Value)?;
            Ok(Object::Stream(Stream::with_position(
                object.as_dict()?.clone(),
                0,
            )))
        }

        fn value_bytes(
            &self,
            pointer: *const c_char,
            length: usize,
            encoded: &mut usize,
        ) -> Result<&[u8]> {
            self.check()?;
            charge_bytes(length, encoded)?;
            if pointer.is_null() {
                return Err(corrupt("Bundled qpdf returned a null value buffer"));
            }
            Ok(unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length) })
        }

        fn selected_dictionary(
            &self,
            handle: Handle,
            context: Context,
            depth: usize,
            elements: &mut usize,
            encoded: &mut usize,
        ) -> Result<Option<Object>> {
            if !matches!(
                context,
                Context::PageTree
                    | Context::AnnotationEntry
                    | Context::AnnotationIndex
                    | Context::Outline
                    | Context::Root
            ) {
                return Ok(None);
            }
            let kind = unsafe { (self.api.object_type)(self.data, handle) };
            self.check()?;
            if kind != 9 {
                return Ok(None);
            }
            let index = context == Context::AnnotationIndex;
            if context == Context::AnnotationEntry {
                let reply = unsafe { (self.api.has_key)(self.data, handle, c"/IRT".as_ptr()) } != 0;
                self.check()?;
                if reply {
                    return Ok(None);
                }
                let subtype = self.handle(unsafe {
                    (self.api.get_key)(self.data, handle, c"/Subtype".as_ptr())
                })?;
                let mut pointer = std::ptr::null();
                let mut length = 0;
                let name =
                    unsafe { (self.api.name)(self.data, subtype.value, &mut pointer, &mut length) }
                        != 0;
                self.check()?;
                if name {
                    let bytes = self.value_bytes(pointer, length, &mut 0)?;
                    let name = bytes
                        .strip_prefix(b"/")
                        .ok_or_else(|| corrupt("PDF name is missing its slash"))?;
                    if !crate::annotation_parse::parsed_annotation_subtype(
                        &String::from_utf8_lossy(name),
                    )
                    .is_empty()
                    {
                        return Ok(None);
                    }
                }
            }
            // Select only through the actual page-tree or Annots ownership
            // context. Private dictionaries always keep their complete graph.
            let keys = if context == Context::PageTree {
                if matches!(
                    self.purpose,
                    QpdfMetadataPurpose::Annotations | QpdfMetadataPurpose::AnnotationIndex
                ) {
                    &[
                        c"/Type",
                        c"/Kids",
                        c"/Parent",
                        c"/Count",
                        c"/MediaBox",
                        c"/CropBox",
                        c"/Rotate",
                        c"/UserUnit",
                        c"/Annots",
                    ][..]
                } else {
                    &[
                        c"/Type",
                        c"/Kids",
                        c"/Parent",
                        c"/Count",
                        c"/MediaBox",
                        c"/CropBox",
                        c"/Rotate",
                        c"/UserUnit",
                    ][..]
                }
            } else if context == Context::Root {
                match self.purpose {
                    QpdfMetadataPurpose::Catalog => &[
                        c"/Type",
                        c"/Pages",
                        c"/Outlines",
                        c"/PageLabels",
                        c"/Dests",
                        c"/Names",
                        c"/AcroForm",
                        c"/AF",
                    ][..],
                    QpdfMetadataPurpose::Conformance => {
                        &[c"/Type", c"/AcroForm", c"/StructTreeRoot"][..]
                    }
                    _ => &[c"/Type", c"/Pages"][..],
                }
            } else if context == Context::Outline {
                &[
                    c"/Title", c"/A", c"/Dest", c"/First", c"/Next", c"/F", c"/C",
                ][..]
            } else if index {
                &[c"/Subtype", c"/NM", c"/IRT", c"/Popup", c"/Parent"][..]
            } else {
                &[c"/Subtype", c"/NM"][..]
            };
            let mut dictionary = Dictionary::new();
            for key in keys {
                if unsafe { (self.api.has_key)(self.data, handle, key.as_ptr()) } == 0 {
                    self.check()?;
                    continue;
                }
                let value =
                    self.handle(unsafe { (self.api.get_key)(self.data, handle, key.as_ptr()) })?;
                let child_context = if context == Context::PageTree && *key == c"/Annots" {
                    if self.purpose == QpdfMetadataPurpose::AnnotationIndex {
                        Context::AnnotationIndex
                    } else {
                        Context::AnnotationEntry
                    }
                } else if (context == Context::Root && *key == c"/Outlines")
                    || (context == Context::Outline
                        && matches!(key.to_bytes(), b"/First" | b"/Next"))
                {
                    Context::Outline
                } else {
                    Context::Value
                };
                charge_bytes(key.to_bytes().len(), encoded)?;
                let object = self.typed(
                    value.value,
                    false,
                    depth + 1,
                    elements,
                    encoded,
                    child_context,
                )?;
                dictionary.set(&key.to_bytes()[1..], object);
            }
            Ok(Some(Object::Dictionary(dictionary)))
        }

        fn typed(
            &self,
            handle: Handle,
            top: bool,
            depth: usize,
            elements: &mut usize,
            encoded: &mut usize,
            context: Context,
        ) -> Result<Object> {
            charge_element(depth, elements)?;
            if !top && unsafe { (self.api.is_indirect)(self.data, handle) } != 0 {
                let number = unsafe { (self.api.object_id)(self.data, handle) };
                let generation = unsafe { (self.api.generation)(self.data, handle) };
                self.check()?;
                return Ok(Object::Reference((
                    u32::try_from(number)?,
                    u16::try_from(generation)?,
                )));
            }
            let kind = unsafe { (self.api.object_type)(self.data, handle) };
            self.check()?;
            let object = match kind {
                2 => Object::Null,
                3 => Object::Boolean(unsafe { (self.api.boolean)(self.data, handle) } != 0),
                4 => {
                    let mut value = 0i64;
                    if unsafe { (self.api.integer)(self.data, handle, &mut value) } == 0 {
                        self.check()?;
                        return Err(corrupt("PDF integer exceeds i64"));
                    }
                    Object::Integer(value)
                }
                5 | 7 => {
                    let mut pointer = std::ptr::null();
                    let mut length = 0usize;
                    let read = if kind == 5 {
                        self.api.real
                    } else {
                        self.api.name
                    };
                    if unsafe { read(self.data, handle, &mut pointer, &mut length) } == 0 {
                        self.check()?;
                        return Err(corrupt("Bundled qpdf returned an invalid scalar value"));
                    }
                    let bytes = self.value_bytes(pointer, length, encoded)?;
                    if kind == 7 {
                        let name = bytes
                            .strip_prefix(b"/")
                            .ok_or_else(|| corrupt("PDF name is missing its slash"))?;
                        Object::Name(name.to_vec())
                    } else {
                        // qpdf's JSON writer turns a bare decimal point into
                        // 0.0, including its signed form. Keep that read view.
                        let number = match bytes {
                            b"" | b"." => 0.0,
                            b"-." => -0.0,
                            _ => std::str::from_utf8(bytes)?.parse::<f64>()?,
                        };
                        let value = number as f32;
                        if !number.is_finite() || !value.is_finite() {
                            return Err(corrupt("PDF real number is not finite or exceeds f32"));
                        }
                        Object::Real(value)
                    }
                }
                6 => {
                    let mut length = 0usize;
                    let pointer = unsafe { (self.api.string)(self.data, handle, &mut length) };
                    Object::String(
                        self.value_bytes(pointer, length, encoded)?.to_vec(),
                        StringFormat::Hexadecimal,
                    )
                }
                8 => {
                    let length = unsafe { (self.api.array_length)(self.data, handle) };
                    self.check()?;
                    let length = usize::try_from(length)?;
                    if length > MAX_QPDF_OBJECT_ELEMENTS.saturating_sub(*elements) {
                        return Err(limited("Selected qpdf array exceeds its element ceiling"));
                    }
                    let mut values = Vec::with_capacity(length);
                    for index in 0..length {
                        let item = self.handle(unsafe {
                            (self.api.array_item)(self.data, handle, c_int::try_from(index)?)
                        })?;
                        values.push(self.typed(
                            item.value,
                            false,
                            depth + 1,
                            elements,
                            encoded,
                            context,
                        )?);
                    }
                    Object::Array(values)
                }
                9 => {
                    if let Some(object) =
                        self.selected_dictionary(handle, context, depth, elements, encoded)?
                    {
                        return Ok(object);
                    }
                    // qpdf supports only one C dictionary iterator at a time.
                    // Copy its keys before descending into any child dictionary.
                    let mut keys = Vec::new();
                    unsafe { (self.api.begin_keys)(self.data, handle) };
                    self.check()?;
                    while unsafe { (self.api.more_keys)(self.data) } != 0 {
                        let pointer = unsafe { (self.api.next_key)(self.data) };
                        self.check()?;
                        if pointer.is_null()
                            || keys.len() >= MAX_QPDF_OBJECT_ELEMENTS.saturating_sub(*elements)
                        {
                            return Err(limited(
                                "Selected qpdf dictionary exceeds its element ceiling",
                            ));
                        }
                        let key = unsafe { CStr::from_ptr(pointer) }.to_bytes();
                        charge_bytes(key.len(), encoded)?;
                        keys.push(key.to_vec());
                    }
                    let mut dictionary = Dictionary::new();
                    for key in keys {
                        let c_key = CString::new(key.clone())
                            .map_err(|_| corrupt("PDF dictionary key contains NUL"))?;
                        let value = self.handle(unsafe {
                            (self.api.get_key)(self.data, handle, c_key.as_ptr())
                        })?;
                        let name = key
                            .strip_prefix(b"/")
                            .ok_or_else(|| corrupt("PDF dictionary key is missing its slash"))?;
                        dictionary.set(
                            name,
                            self.typed(
                                value.value,
                                false,
                                depth + 1,
                                elements,
                                encoded,
                                Context::Value,
                            )?,
                        );
                    }
                    Object::Dictionary(dictionary)
                }
                _ => {
                    return Err(corrupt(
                        "Bundled qpdf returned an unsupported metadata object type",
                    ));
                }
            };
            self.check()?;
            Ok(object)
        }
    }

    fn adjacent_library(qpdf_path: &Path) -> Result<Option<PathBuf>> {
        let Some(bin) = qpdf_path.parent() else {
            return Ok(None);
        };
        #[cfg(windows)]
        let directory = bin.to_path_buf();
        #[cfg(not(windows))]
        let directory = bin.parent().unwrap_or(bin).join("lib");
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_domain_error(error)),
        };
        let mut candidates = Vec::new();
        for entry in entries {
            let entry = entry.map_err(io_domain_error)?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            #[cfg(target_os = "macos")]
            let matches = name == "libqpdf.dylib"
                || (name.starts_with("libqpdf.") && name.ends_with(".dylib"));
            #[cfg(all(not(target_os = "macos"), not(windows)))]
            let matches = name == "libqpdf.so" || name.starts_with("libqpdf.so.");
            #[cfg(windows)]
            let matches =
                name.ends_with(".dll") && (name.starts_with("qpdf") || name.starts_with("libqpdf"));
            if matches {
                candidates.push(entry.path());
            }
        }
        candidates.sort();
        candidates
            .into_iter()
            .next()
            .map(fs::canonicalize)
            .transpose()
            .map_err(io_domain_error)
    }

    #[derive(Clone, Copy, Eq, Hash, PartialEq)]
    enum Context {
        Root,
        PageTree,
        Value,
        AnnotationEntry,
        Annotation,
        AnnotationIndex,
        Catalog,
        Outline,
        Names,
        Conformance,
    }

    struct Projection<'a> {
        reader: &'a Reader,
        document: Document,
        pending: VecDeque<(ObjectId, Context)>,
        visited: HashSet<(ObjectId, Context)>,
        retained: usize,
    }

    impl Projection<'_> {
        fn enqueue(&mut self, object: &Object, context: Context, depth: usize) -> Result<()> {
            if depth > MAX_PDF_STRUCTURAL_NESTING {
                return Err(limited(
                    "PDF metadata graph exceeds its structural depth ceiling",
                ));
            }
            match object {
                Object::Reference(id) => {
                    if !self.visited.contains(&(*id, context)) {
                        if self.pending.len() >= MAX_QPDF_OBJECT_ELEMENTS {
                            return Err(limited("PDF metadata graph exceeds its object ceiling"));
                        }
                        // Discover physical pages before optional graphs. Their
                        // identity then comes from the actual page tree, not a
                        // private dictionary that happens to use /Type /Page.
                        if matches!(context, Context::Root | Context::PageTree | Context::Value) {
                            self.pending.push_back((*id, context));
                        } else {
                            self.pending.push_front((*id, context));
                        }
                    }
                }
                Object::Array(values) => {
                    for value in values {
                        self.enqueue(value, context, depth + 1)?;
                    }
                }
                Object::Dictionary(dictionary) => self.targets(dictionary, context, depth + 1)?,
                Object::Stream(stream) => self.targets(&stream.dict, context, depth + 2)?,
                _ => {}
            }
            Ok(())
        }

        fn targets(&mut self, dict: &Dictionary, context: Context, depth: usize) -> Result<()> {
            let kind = dict
                .get(b"Type")
                .ok()
                .and_then(|value| value.as_name().ok());
            if context == Context::PageTree {
                for key in [
                    b"Kids".as_slice(),
                    b"Parent",
                    b"Count",
                    b"MediaBox",
                    b"CropBox",
                    b"Rotate",
                ] {
                    if let Ok(value) = dict.get(key) {
                        self.enqueue(
                            value,
                            if key == b"Kids" || key == b"Parent" {
                                Context::PageTree
                            } else {
                                Context::Value
                            },
                            depth,
                        )?;
                    }
                }
                if kind == Some(b"Page") {
                    if let Ok(unit) = dict.get(b"UserUnit") {
                        self.enqueue(unit, Context::Value, depth)?;
                    }
                    if matches!(
                        self.reader.purpose,
                        QpdfMetadataPurpose::Annotations | QpdfMetadataPurpose::AnnotationIndex
                    ) {
                        if let Ok(annots) = dict.get(b"Annots") {
                            self.enqueue(
                                annots,
                                if self.reader.purpose == QpdfMetadataPurpose::AnnotationIndex {
                                    Context::AnnotationIndex
                                } else {
                                    Context::AnnotationEntry
                                },
                                depth,
                            )?;
                        }
                    }
                }
                return Ok(());
            }
            if context == Context::Root {
                for (key, value) in dict.iter() {
                    let child_context = match (self.reader.purpose, key.as_slice()) {
                        (QpdfMetadataPurpose::Catalog, b"Outlines") => Context::Outline,
                        (QpdfMetadataPurpose::Catalog, b"Names") => Context::Names,
                        (QpdfMetadataPurpose::Catalog, b"PageLabels" | b"Dests") => {
                            Context::Catalog
                        }
                        (QpdfMetadataPurpose::Conformance, b"AcroForm" | b"StructTreeRoot") => {
                            Context::Conformance
                        }
                        _ => continue,
                    };
                    self.enqueue(value, child_context, depth)?;
                }
                // Inline optional graphs may queue destination page values.
                // Queue Pages last so physical identities are discovered first.
                if self.reader.purpose != QpdfMetadataPurpose::Conformance {
                    if let Ok(pages) = dict.get(b"Pages") {
                        self.enqueue(pages, Context::PageTree, depth)?;
                    }
                }
                return Ok(());
            }
            for (key, value) in dict.iter() {
                if context == Context::AnnotationIndex
                    && !matches!(key.as_slice(), b"Subtype" | b"NM")
                {
                    continue;
                }
                if context == Context::Names && key.as_slice() != b"Dests" {
                    continue;
                }
                if context == Context::Conformance {
                    continue;
                }
                self.enqueue(
                    value,
                    if context == Context::AnnotationEntry {
                        Context::Annotation
                    } else if context == Context::AnnotationIndex {
                        Context::Value
                    } else if context == Context::Names {
                        Context::Catalog
                    } else if context == Context::Outline
                        && !matches!(key.as_slice(), b"First" | b"Next")
                    {
                        Context::Value
                    } else {
                        context
                    },
                    depth,
                )?;
            }
            Ok(())
        }

        fn insert(&mut self, id: ObjectId, object: Object) -> Result<()> {
            let previous = self
                .document
                .objects
                .get(&id)
                .map(retained_cost)
                .transpose()?
                .unwrap_or(0);
            if previous == 0 && self.document.objects.len() >= MAX_QPDF_OBJECT_ELEMENTS {
                return Err(limited("PDF metadata graph exceeds its object ceiling"));
            }
            let cost = retained_cost(&object)?;
            self.retained = self
                .retained
                .checked_sub(previous)
                .ok_or_else(|| limited("PDF metadata retained size underflow"))?
                .checked_add(cost)
                .ok_or_else(|| limited("PDF metadata retained size overflow"))?;
            if self.retained > MAX_QPDF_RETAINED_STRUCTURE_BYTES {
                return Err(limited(
                    "Selected qpdf metadata exceeds its retained memory ceiling",
                ));
            }
            self.document.objects.insert(id, object);
            Ok(())
        }

        fn drain(&mut self) -> Result<()> {
            while let Some((id, context)) = self.pending.pop_back() {
                if !self.visited.insert((id, context)) {
                    continue;
                }
                if !matches!(context, Context::Root | Context::PageTree)
                    && (self.visited.contains(&(id, Context::Root))
                        || self.visited.contains(&(id, Context::PageTree)))
                {
                    continue;
                }
                // Entry projections may have been read before a note's full
                // recovery graph reaches the same object. Full reads dominate.
                if (context == Context::AnnotationEntry
                    && (self.visited.contains(&(id, Context::Annotation))
                        || self.visited.contains(&(id, Context::Value))))
                    || (context == Context::Outline
                        && (self.visited.contains(&(id, Context::Catalog))
                            || self.visited.contains(&(id, Context::Value))))
                {
                    continue;
                }
                if self.visited.len() > MAX_QPDF_OBJECT_ELEMENTS {
                    return Err(limited("PDF metadata graph exceeds its object ceiling"));
                }
                let object = self.reader.object(id, context)?;
                self.enqueue(&object, context, 0)?;
                // Names keeps a full dictionary but follows only Dests. Retain
                // it after walking this same object's selected outline edges.
                if context != Context::Outline || !self.visited.contains(&(id, Context::Names)) {
                    self.insert(id, object)?;
                }
            }
            Ok(())
        }
    }

    fn charge_element(depth: usize, elements: &mut usize) -> Result<()> {
        *elements += 1;
        if *elements > MAX_QPDF_OBJECT_ELEMENTS || depth > MAX_PDF_STRUCTURAL_NESTING {
            return Err(limited(
                "Selected qpdf object exceeds its element or nesting ceiling",
            ));
        }
        Ok(())
    }

    /// Names, strings, reals and dictionary keys charge their bytes before
    /// they are copied, so one object's values cannot exceed its byte ceiling.
    fn charge_bytes(count: usize, encoded: &mut usize) -> Result<()> {
        *encoded = encoded.saturating_add(count);
        if *encoded > MAX_QPDF_OBJECT_BYTES {
            return Err(limited("qpdf object exceeds its structural byte ceiling"));
        }
        Ok(())
    }

    fn read_signatures(projection: &mut Projection<'_>, path: &Path, qpdf: &Path) -> Result<()> {
        let temp = TempQpdfFiles::create()?;
        run_qpdf_bounded(path, qpdf, &["--show-xref"], &temp, MAX_XREF_BYTES)?;
        let file = File::open(&temp.structure).map_err(io_domain_error)?;
        let mut count = 0usize;
        for line in BufReader::new(file).lines() {
            let line = line.map_err(io_domain_error)?;
            count += 1;
            if count > MAX_QPDF_OBJECT_ELEMENTS {
                return Err(limited("PDF xref exceeds its object ceiling"));
            }
            let (reference, _) = line
                .split_once(": ")
                .ok_or_else(|| corrupt("Malformed qpdf xref row"))?;
            let (number, generation) = reference
                .split_once('/')
                .ok_or_else(|| corrupt("Malformed qpdf xref reference"))?;
            let id = (number.parse::<u32>()?, generation.parse::<u16>()?);
            if projection.reader.is_signature(id)? {
                // Keep the exact global predicate even on a selected Root,
                // preserving its other facts without reading signature payloads.
                let mut witness = Object::Dictionary(Dictionary::new());
                if let Some(existing) = projection.document.objects.get(&id) {
                    witness = existing.clone();
                }
                let dictionary = match &mut witness {
                    Object::Dictionary(dictionary) => dictionary,
                    Object::Stream(stream) => &mut stream.dict,
                    _ => return Err(corrupt("Signature witness is not a dictionary")),
                };
                dictionary.set("ByteRange", Object::Null);
                dictionary.set("Contents", Object::Null);
                projection.insert(id, witness)?;
            }
            projection.reader.checkpoint()?;
        }
        Ok(())
    }

    pub(super) fn load(
        path: &Path,
        qpdf: &Path,
        purpose: QpdfMetadataPurpose,
    ) -> Result<Option<(IncrementalDocument, bool)>> {
        let Some(library) = adjacent_library(qpdf)? else {
            return Ok(None);
        };
        let initial = fs::metadata(path).map_err(io_domain_error)?;
        let recovered = purpose == QpdfMetadataPurpose::Conformance;
        let reader = Reader::open(&library, path, purpose)?;
        let mut document = Document::with_version(reader.version()?);
        document.trailer = reader.trailer()?;
        document.max_id = document
            .trailer
            .get(b"Size")
            .ok()
            .and_then(|size| size.as_i64().ok())
            .and_then(|size| size.checked_sub(1))
            .and_then(|size| u32::try_from(size).ok())
            .unwrap_or(0);
        if !recovered {
            assert_plaintext_base(
                &document,
                "Encrypted PDFs are not supported by native metadata reads",
            )?;
        }
        let root = document.trailer.get(b"Root")?.clone();
        let retained = retained_cost(&Object::Dictionary(document.trailer.clone()))?;
        let mut projection = Projection {
            reader: &reader,
            document,
            pending: VecDeque::new(),
            visited: HashSet::new(),
            retained,
        };
        projection.enqueue(&root, Context::Root, 0)?;
        projection.drain()?;
        if recovered {
            read_signatures(&mut projection, path, qpdf)?;
        }
        let current = fs::metadata(path).map_err(io_domain_error)?;
        if current.len() != initial.len() || current.modified().ok() != initial.modified().ok() {
            return Err(corrupt("PDF input changed while reading native metadata"));
        }
        let mut file = File::open(path).map_err(io_domain_error)?;
        let last = read_last_byte_from_file(&mut file, initial.len())?;
        let unavailable = projection
            .document
            .objects
            .iter()
            .filter_map(|(id, object)| matches!(object, Object::Stream(_)).then_some(*id))
            .collect();
        let mut incremental =
            IncrementalDocument::from_document(projection.document, initial.len(), last);
        incremental.unavailable_base_streams = unavailable;
        Ok(Some((incremental, reader.diagnostic_bytes.get() != 0)))
    }

    pub(super) fn load_page_local(
        path: &Path,
        qpdf: &Path,
        edit: &PageLocalEdit,
    ) -> Result<Option<(Document, Vec<ObjectId>)>> {
        let Some(library) = adjacent_library(qpdf)? else {
            return Ok(None);
        };
        // Whole-object reads never consult the projection purpose.
        let reader = Reader::open(&library, path, QpdfMetadataPurpose::Geometry)?;
        let page_ids_by_number = reader.page_ids()?;
        let mut document = Document::with_version(reader.version()?);
        document.trailer = reader.trailer()?;
        // qpdf counts objects only after resolving every one of them. The
        // admitted cross-reference chain bounds object numbers without that.
        let largest_size = path_xref_chain(path, fs::metadata(path)?.len())
            .ok()
            .and_then(|chain| chain.largest_size);
        document.max_id = match largest_size {
            Some(size) => u32::try_from(size.saturating_sub(1))?,
            None => reader.max_object_number()?,
        };
        complete_page_local_objects(
            &mut document,
            &page_ids_by_number,
            edit,
            |document, batch, retained| {
                for id in batch {
                    // qpdf reads a missing object as null; leave it absent,
                    // as the eager reader and the JSON query do.
                    let object = reader.object(*id, Context::Value)?;
                    if !matches!(object, Object::Null) {
                        *retained = charge_retained(*retained, &object)?;
                        document.objects.insert(*id, object);
                    }
                }
                Ok(())
            },
        )?;
        Ok(Some((document, page_ids_by_number)))
    }
}

/// The base objects a page-local edit reads, through the bundled library.
/// None means only that the supplied qpdf executable has no adjacent library.
pub(crate) fn load_qpdf_page_local_objects(
    path: &Path,
    qpdf_path: &Path,
    edit: &PageLocalEdit,
) -> Result<Option<(Document, Vec<ObjectId>)>> {
    #[cfg(not(target_family = "wasm"))]
    {
        platform::load_page_local(path, qpdf_path, edit)
    }
    #[cfg(target_family = "wasm")]
    {
        let _ = (path, qpdf_path, edit);
        Ok(None)
    }
}
