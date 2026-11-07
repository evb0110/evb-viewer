/* PDF JPXDecode samples through OpenJPEG 2.5.4, the release the desktop's
 * bundled Poppler links: full resolution, every quality layer, components
 * interleaved as decoded. Linked into the browser engines only.
 *
 * OpenJPEG allocates through the caller's allocator (this file replaces
 * opj_malloc.c and opj_clock.c), so C and Rust share one heap without
 * exporting an allocator from the module. Diagnostics are discarded. */
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "openjpeg.h"

typedef struct {
  void *(*allocate)(size_t size);
  void (*release)(void *pointer);
  void *(*reallocate)(void *pointer, size_t size);
} evb_jpx_allocator;

static const evb_jpx_allocator *active_allocator;

void *opj_malloc(size_t size) { return size ? active_allocator->allocate(size) : NULL; }
void *opj_calloc(size_t count, size_t size) {
  if (!count || !size || count > SIZE_MAX / size) return NULL;
  void *pointer = active_allocator->allocate(count * size);
  if (pointer) memset(pointer, 0, count * size);
  return pointer;
}
void *opj_realloc(void *pointer, size_t size) {
  return size ? active_allocator->reallocate(pointer, size) : NULL;
}
void opj_free(void *pointer) {
  if (pointer) active_allocator->release(pointer);
}
/* The allocator aligns every block to 32 bytes. */
void *opj_aligned_malloc(size_t size) { return opj_malloc(size); }
void *opj_aligned_32_malloc(size_t size) { return opj_malloc(size); }
void *opj_aligned_realloc(void *pointer, size_t size) { return opj_realloc(pointer, size); }
void *opj_aligned_32_realloc(void *pointer, size_t size) { return opj_realloc(pointer, size); }
void opj_aligned_free(void *pointer) { opj_free(pointer); }
double opj_clock(void) { return 0; }

int evb_jpx_fprintf(FILE *file, const char *format, ...) {
  (void)file;
  (void)format;
  return 0;
}
int evb_jpx_printf(const char *format, ...) {
  (void)format;
  return 0;
}
int evb_jpx_vsnprintf(char *buffer, size_t size, const char *format, va_list arguments) {
  (void)format;
  (void)arguments;
  if (size) buffer[0] = 0;
  return 0;
}
char *evb_jpx_getenv(const char *name) {
  (void)name;
  return NULL;
}

typedef struct {
  const unsigned char *data;
  size_t length, position;
} memory_source;

static OPJ_SIZE_T read_source(void *buffer, OPJ_SIZE_T size, void *context) {
  memory_source *source = context;
  size_t remaining = source->length - source->position;
  if (!remaining) return (OPJ_SIZE_T)-1;
  if (size > remaining) size = remaining;
  memcpy(buffer, source->data + source->position, size);
  source->position += size;
  return size;
}
static OPJ_OFF_T skip_source(OPJ_OFF_T size, void *context) {
  memory_source *source = context;
  if (size < 0 || (uint64_t)size > source->length - source->position) return -1;
  source->position += (size_t)size;
  return size;
}
static OPJ_BOOL seek_source(OPJ_OFF_T position, void *context) {
  memory_source *source = context;
  if (position < 0 || (uint64_t)position > source->length) return OPJ_FALSE;
  source->position = (size_t)position;
  return OPJ_TRUE;
}

/* 0 decoded; 1 not decodable; 2 a variant this path does not decode (not
 * 8-bit unsigned, subsampled, alpha, a YCC color space, or another component
 * count); 3 the image's size differs from the PDF image's. `pixels` holds
 * width * height * components bytes; the header is checked before any tile
 * is decoded. */
int evb_jpx_decode(const evb_jpx_allocator *allocator, const unsigned char *input,
                   size_t length, unsigned width, unsigned height, unsigned components,
                   unsigned char *pixels) {
  int status = 1;
  opj_codec_t *codec = NULL;
  opj_stream_t *stream = NULL;
  opj_image_t *image = NULL;
  opj_dparameters_t parameters;
  memory_source source = {input, length, 0};
  active_allocator = allocator;
  opj_set_default_decoder_parameters(&parameters);
  codec = opj_create_decompress(length >= 2 && input[0] == 0xff && input[1] == 0x4f
                                    ? OPJ_CODEC_J2K
                                    : OPJ_CODEC_JP2);
  if (!codec || !opj_setup_decoder(codec, &parameters)) goto done;
  stream = opj_stream_create(65536, OPJ_TRUE);
  if (!stream) goto done;
  opj_stream_set_user_data(stream, &source, NULL);
  opj_stream_set_user_data_length(stream, length);
  opj_stream_set_read_function(stream, read_source);
  opj_stream_set_skip_function(stream, skip_source);
  opj_stream_set_seek_function(stream, seek_source);
  if (!opj_read_header(stream, codec, &image)) goto done;
  /* A YCC color space would need a conversion this path does not apply. */
  if (image->numcomps != components || image->color_space == OPJ_CLRSPC_SYCC ||
      image->color_space == OPJ_CLRSPC_EYCC) {
    status = 2;
    goto done;
  }
  for (unsigned index = 0; index < components; ++index) {
    const opj_image_comp_t *component = &image->comps[index];
    if (component->prec != 8 || component->sgnd || component->alpha || component->dx != 1 ||
        component->dy != 1) {
      status = 2;
      goto done;
    }
  }
  if (image->x1 - image->x0 != width || image->y1 - image->y0 != height) {
    status = 3;
    goto done;
  }
  if (!opj_decode(codec, stream, image) || !opj_end_decompress(codec, stream)) goto done;
  for (unsigned index = 0; index < components; ++index) {
    if (image->comps[index].w != width || image->comps[index].h != height ||
        !image->comps[index].data) {
      status = 3;
      goto done;
    }
  }
  for (size_t pixel = 0; pixel < (size_t)width * height; ++pixel) {
    for (unsigned index = 0; index < components; ++index) {
      int value = image->comps[index].data[pixel];
      pixels[pixel * components + index] = (unsigned char)(value < 0 ? 0 : value > 255 ? 255 : value);
    }
  }
  status = 0;
done:
  if (image) opj_image_destroy(image);
  if (stream) opj_stream_destroy(stream);
  if (codec) opj_destroy_codec(codec);
  active_allocator = NULL;
  return status;
}
