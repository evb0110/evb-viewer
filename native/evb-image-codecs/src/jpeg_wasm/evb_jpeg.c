/* PDF DCT samples through libjpeg-turbo, decoded as Poppler's DCTStream
 * configures libjpeg: full resolution, islow IDCT, fancy upsampling and
 * block smoothing, gray or RGB output. Linked into the browser engines only.
 *
 * wasm32 has no setjmp here: a fatal libjpeg error traps, and the browser
 * discards the trapped engine and loads a fresh one. Allocation goes through
 * the caller's allocator, so C and Rust share one heap without exporting an
 * allocator from the module. */
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include "jpeglib.h"
#include "jpegint.h"

typedef struct {
  void *(*allocate)(size_t size);
  void (*release)(void *pointer);
} evb_jpeg_allocator;

static const evb_jpeg_allocator *active_allocator;

void *evb_jpeg_malloc(size_t size) { return active_allocator->allocate(size); }
void evb_jpeg_free(void *pointer) {
  if (pointer) active_allocator->release(pointer);
}

static void fatal(j_common_ptr cinfo) {
  (void)cinfo;
  __builtin_trap();
}
static void silent(j_common_ptr cinfo) { (void)cinfo; }
static void emit(j_common_ptr cinfo, int level) { (void)cinfo; (void)level; }
static void format(j_common_ptr cinfo, char *buffer) {
  (void)cinfo;
  buffer[0] = 0;
}

/* 0 decoded; 1 the stream's size differs from the PDF image's; 2 a variant
 * this path does not decode. `pixels` holds width * height * components. */
int evb_jpeg_decode(const evb_jpeg_allocator *allocator, const unsigned char *input,
                    size_t length, unsigned width, unsigned height, unsigned components,
                    unsigned char *pixels) {
  struct jpeg_decompress_struct jpeg;
  struct jpeg_error_mgr error;
  int status = 0;
  active_allocator = allocator;
  memset(&error, 0, sizeof(error));
  error.error_exit = fatal;
  error.emit_message = emit;
  error.output_message = silent;
  error.format_message = format;
  error.reset_error_mgr = silent;
  jpeg.err = &error;
  jpeg_create_decompress(&jpeg);
  jpeg_mem_src(&jpeg, input, length);
  jpeg_read_header(&jpeg, TRUE);
  if (jpeg.data_precision != 8 || jpeg.num_components != (int)components ||
      jpeg.master->lossless) {
    status = 2;
  } else if (jpeg.image_width != width || jpeg.image_height != height) {
    status = 1;
  } else {
    jpeg.scale_num = 1;
    jpeg.scale_denom = 1;
    jpeg.out_color_space = components == 1 ? JCS_GRAYSCALE : JCS_RGB;
    jpeg.dct_method = JDCT_ISLOW;
    jpeg.do_fancy_upsampling = TRUE;
    jpeg.do_block_smoothing = TRUE;
    jpeg_start_decompress(&jpeg);
    if (jpeg.output_width != width || jpeg.output_height != height ||
        jpeg.output_components != (int)components) {
      status = 1;
    } else {
      size_t stride = (size_t)width * components;
      while (jpeg.output_scanline < height) {
        JSAMPROW row = pixels + (size_t)jpeg.output_scanline * stride;
        if (jpeg_read_scanlines(&jpeg, &row, 1) != 1) break;
      }
      /* A stream that ends early leaves its remaining rows as libjpeg left
       * them, as Poppler draws it; finishing would read past the data. */
    }
  }
  jpeg_destroy_decompress(&jpeg);
  active_allocator = NULL;
  return status;
}
