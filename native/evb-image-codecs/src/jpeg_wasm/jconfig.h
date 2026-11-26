/* libjpeg-turbo 3.1.2 configuration for the wasm32 decoder: 8-bit samples,
 * memory source, arithmetic decoding, no SIMD. */
#define JPEG_LIB_VERSION 62
#define LIBJPEG_TURBO_VERSION 3.1.2
#define LIBJPEG_TURBO_VERSION_NUMBER 3001002
#define D_ARITH_CODING_SUPPORTED 1
#define MEM_SRCDST_SUPPORTED 1
#ifndef BITS_IN_JSAMPLE
#define BITS_IN_JSAMPLE 8
#endif
