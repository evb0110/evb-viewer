/* libjpeg-turbo 3.1.2 internal configuration for wasm32 (clang). */
#define BUILD "evb-wasm32"
#define HIDDEN __attribute__((visibility("hidden")))
#define INLINE __inline__ __attribute__((always_inline))
#define THREAD_LOCAL
#define PACKAGE_NAME "libjpeg-turbo"
#define VERSION "3.1.2"
#define SIZEOF_SIZE_T 4
#define HAVE_BUILTIN_CTZL
#define FALLTHROUGH __attribute__((fallthrough));
#ifndef BITS_IN_JSAMPLE
#define BITS_IN_JSAMPLE 8
#endif
#undef C_ARITH_CODING_SUPPORTED
#undef D_ARITH_CODING_SUPPORTED
#undef WITH_SIMD
#if BITS_IN_JSAMPLE == 8
#define D_ARITH_CODING_SUPPORTED 1
#endif
