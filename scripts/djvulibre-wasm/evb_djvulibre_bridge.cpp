// EVB Viewer DjVuLibre WebAssembly C bridge.
// Wraps libdjvulibre 3.5.30 (single-threaded Emscripten build) with a minimal,
// bounded-memory C ABI shared by browser Web Workers and Electron worker_threads.

#include <emscripten.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <new>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "BSByteStream.h"
#include "ByteStream.h"
#include "DataPool.h"
#include "DjVmDir.h"
#include "DjVmDir0.h"
#include "DjVmNav.h"
#include "DjVuAnno.h"
#include "DjVuDocument.h"
#include "DjVuFile.h"
#include "DjVuFileCache.h"
#include "DjVuImage.h"
#include "DjVuInfo.h"
#include "DjVuPort.h"
#include "DjVuText.h"
#include "GBitmap.h"
#include "GException.h"
#include "GPixmap.h"
#include "GRect.h"
#include "GString.h"
#include "GURL.h"
#include "IFFByteStream.h"
#include "IW44Image.h"
#include "JB2Image.h"

using namespace DJVU;

namespace {

constexpr int32_t EVB_DJVU_OK = 0;
constexpr int32_t EVB_DJVU_NEED_COMPONENT = 1;
constexpr int32_t EVB_DJVU_ERR_INVALID = -1;
constexpr int32_t EVB_DJVU_ERR_OOM = -2;
constexpr int32_t EVB_DJVU_ERR_BOUNDS = -3;
constexpr int32_t EVB_DJVU_ERR_INTERNAL = -4;

constexpr int32_t RENDER_MODE_COLOR = 0;
constexpr int32_t RENDER_MODE_BLACK = 1;
constexpr int32_t RENDER_MODE_MASKONLY = 2;
constexpr int32_t RENDER_MODE_BACKGROUND = 3;
constexpr int32_t RENDER_MODE_FOREGROUND = 4;

constexpr int32_t PIXEL_FORMAT_RGBA32 = 0;
constexpr int32_t PIXEL_FORMAT_RGB24 = 1;
constexpr int32_t PIXEL_FORMAT_PBM_MSB = 2;

constexpr uint32_t MIN_CACHE_BYTES = 4u * 1024u * 1024u;
constexpr uint32_t MAX_CACHE_BYTES = 64u * 1024u * 1024u;
constexpr size_t MAX_COMPONENT_BYTES = 64u * 1024u * 1024u;
constexpr size_t MAX_INIT_BYTES = 64u * 1024u * 1024u;
constexpr size_t MAX_PROVIDED_COMPONENT_CACHE_BYTES = 32u * 1024u * 1024u;
constexpr int MAX_NATIVE_PAGE_DIM = 32768;
constexpr uint64_t MAX_NATIVE_PAGE_PIXELS = 128ull * 1000ull * 1000ull;
constexpr int MAX_RENDER_DIM = 32768;
constexpr uint64_t MAX_RENDER_PIXELS = 100ull * 1000ull * 1000ull;
constexpr uint64_t MAX_RENDER_BUFFER_BYTES = 256ull * 1024ull * 1024ull;
constexpr int MAX_TEXT_ZONE_DEPTH = 16;

// Synchronous host component reader hook.
// JS attaches `Module.evbReadComponentSync(docId, name)` when synchronous reads
// are available (Node fs.readSync / Worker FileReaderSync).
// Return values:
//   1: component written into wasm heap, *outPtr and *outLen populated
//   0: async host needs to fetch component first (caller will return NEED_COMPONENT)
//  -1: component unavailable / error
//  -2: wasm heap allocation failed (OOM)
//  -3: component exceeded byte limit
EM_JS(int32_t, evb_js_read_component,
      (int32_t docId, const char *namePtr, int32_t nameLen, uint32_t *outPtr, uint32_t *outLen), {
  const reader = Module['evbReadComponentSync'];
  if (typeof reader !== 'function') {
    return 0;
  }
  const name = UTF8ToString(namePtr, nameLen);
  let bytes;
  try {
    bytes = reader(docId, name);
  } catch (err) {
    return (err instanceof RangeError) ? -3 : -1;
  }
  if (bytes === null || bytes === undefined) {
    return 0;
  }
  if (bytes === false) {
    return -1;
  }
  const len = bytes.byteLength >>> 0;
  if (len > 67108864) {
    return -3;
  }
  const ptr = _malloc(len > 0 ? len : 1);
  if (!ptr) {
    return -2;
  }
  if (len > 0) {
    HEAPU8.set(bytes, ptr);
  }
  HEAPU32[outPtr >>> 2] = ptr >>> 0;
  HEAPU32[outLen >>> 2] = len;
  return 1;
});

std::vector<uint8_t> g_output;
std::string g_error;
std::string g_missing_component;
int32_t g_render_width = 0;
int32_t g_render_height = 0;
int32_t g_render_present = 0;

void clear_call_state() {
  g_output.clear();
  g_error.clear();
  g_missing_component.clear();
  g_render_width = 0;
  g_render_height = 0;
  g_render_present = 0;
}

void set_error(const std::string &msg) {
  g_error = msg;
}

void set_output_string(const std::string &text) {
  g_output.assign(text.begin(), text.end());
}

void append_json_escaped(std::string &out, const char *data, size_t len) {
  out.push_back('"');
  for (size_t i = 0; i < len; ++i) {
    unsigned char ch = static_cast<unsigned char>(data[i]);
    switch (ch) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (ch < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned>(ch));
          out += buf;
        } else {
          out.push_back(static_cast<char>(ch));
        }
        break;
    }
  }
  out.push_back('"');
}

void append_json_escaped(std::string &out, const std::string &s) {
  append_json_escaped(out, s.data(), s.size());
}

void append_json_escaped(std::string &out, const GUTF8String &s) {
  const char *ptr = static_cast<const char *>(s);
  if (!ptr) {
    out += "\"\"";
    return;
  }
  append_json_escaped(out, ptr, std::strlen(ptr));
}

int orientation_to_degrees(int orientation) {
  // DjVuInfo::decode normalizes raw IFF orientation flags (6 -> 1, 2 -> 2,
  // 5 -> 3, default -> 0) into 90-degree CCW quarter-turn steps.
  switch (orientation & 3) {
    case 1: return 90;
    case 2: return 180;
    case 3: return 270;
    default: return 0;
  }
}

uint16_t read_be16(const uint8_t *p) {
  return static_cast<uint16_t>((static_cast<uint16_t>(p[0]) << 8) | p[1]);
}

bool parse_jpeg_dimensions_from_stream(ByteStream &bs, int chunkSize, int &width, int &height) {
  if (chunkSize < 4) {
    return false;
  }
  const size_t limit = static_cast<size_t>(chunkSize);
  uint8_t soi[2];
  if (bs.readall(soi, 2) != 2 || soi[0] != 0xFF || soi[1] != 0xD8) {
    return false;
  }
  size_t pos = 2;
  while (pos + 2 <= limit) {
    uint8_t byte = 0;
    if (bs.readall(&byte, 1) != 1) {
      break;
    }
    ++pos;
    if (byte != 0xFF) {
      continue;
    }
    while (pos < limit) {
      if (bs.readall(&byte, 1) != 1) {
        return false;
      }
      ++pos;
      if (byte != 0xFF) {
        break;
      }
    }
    if (byte == 0xFF) {
      break;
    }
    const uint8_t marker = byte;
    if (marker == 0xD9 || marker == 0xDA) {
      break;
    }
    if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      continue;
    }
    if (pos + 2 > limit) {
      break;
    }
    uint8_t lenBuf[2];
    if (bs.readall(lenBuf, 2) != 2) {
      break;
    }
    pos += 2;
    const uint16_t segLen = read_be16(lenBuf);
    if (segLen < 2 || pos + (static_cast<size_t>(segLen) - 2u) > limit) {
      break;
    }
    const bool isSof = (marker >= 0xC0 && marker <= 0xC3)
                    || (marker >= 0xC5 && marker <= 0xC7)
                    || (marker >= 0xC9 && marker <= 0xCB)
                    || (marker >= 0xCD && marker <= 0xCF);
    if (isSof && segLen >= 7) {
      uint8_t sof[5];
      if (bs.readall(sof, 5) != 5) {
        break;
      }
      height = read_be16(sof + 1);
      width = read_be16(sof + 3);
      return width > 0 && height > 0;
    }
    const size_t skip = static_cast<size_t>(segLen) - 2u;
    if (skip > 0) {
      if (bs.seek(static_cast<long>(skip), SEEK_CUR, true) < 0) {
        break;
      }
      pos += skip;
    }
  }
  return false;
}

class EvbDjVuPort;

struct EvbDjVuDocumentState {
  int32_t docId = 0;
  bool initDone = false;
  std::vector<uint8_t> initBytes;
  std::unordered_map<std::string, std::vector<uint8_t>> providedComponents;
  std::unordered_set<std::string> pinnedComponents;
  std::vector<std::string> providedOrder;
  size_t providedBytes = 0;
  std::string needComponent;
  bool oomTriggered = false;
  bool limitExceeded = false;
  GP<DjVuFileCache> cache;
  GP<DjVuPort> port;
  GP<DjVuDocument> doc;
  GURL initUrl;
};

class EvbDjVuPort : public DjVuPort {
 public:
  explicit EvbDjVuPort(EvbDjVuDocumentState *state) : state_(state) {}

  GP<DataPool> request_data(const DjVuPort *, const GURL &url) override {
    if (!state_) {
      return nullptr;
    }
    if (url == state_->initUrl
        && (!state_->initDone
            || !state_->doc
            || state_->doc->get_doc_type() != DjVuDocument::INDIRECT)) {
      GP<ByteStream> bs = ByteStream::create(
          state_->initBytes.data(),
          static_cast<int>(state_->initBytes.size()));
      return DataPool::create(bs);
    }

    GUTF8String fname = url.fname();
    std::string name(static_cast<const char *>(fname));
    if (name.empty()) {
      return nullptr;
    }

    // 1. Check explicitly provided component cache (async host path).
    auto it = state_->providedComponents.find(name);
    if (it != state_->providedComponents.end()) {
      // Touch LRU recency and pin while the current decode/page operation uses it.
      state_->pinnedComponents.insert(name);
      auto orderIt = std::find(state_->providedOrder.begin(), state_->providedOrder.end(), name);
      if (orderIt != state_->providedOrder.end()) {
        state_->providedOrder.erase(orderIt);
      }
      state_->providedOrder.push_back(name);
      const auto &buf = it->second;
      GP<ByteStream> bs = ByteStream::create(buf.data(), static_cast<int>(buf.size()));
      return DataPool::create(bs);
    }

    // 2. Try synchronous JS host component read (Node fs / Worker FileReaderSync).
    uint32_t outPtr = 0;
    uint32_t outLen = 0;
    int32_t status = evb_js_read_component(
        state_->docId,
        name.data(),
        static_cast<int32_t>(name.size()),
        &outPtr,
        &outLen);
    if (status == 1) {
      const uint8_t *raw = reinterpret_cast<const uint8_t *>(static_cast<uintptr_t>(outPtr));
      GP<ByteStream> bs = ByteStream::create(raw, static_cast<int>(outLen));
      std::free(reinterpret_cast<void *>(static_cast<uintptr_t>(outPtr)));
      return DataPool::create(bs);
    }
    if (status == -3) {
      state_->limitExceeded = true;
      return nullptr;
    }
    if (status == -2) {
      state_->oomTriggered = true;
      return nullptr;
    }
    if (status == 0) {
      if (state_->needComponent.empty()) {
        state_->needComponent = name;
      }
      return nullptr;
    }
    return nullptr;
  }

  bool notify_error(const DjVuPort *, const GUTF8String &) override {
    return true;
  }

  bool notify_status(const DjVuPort *, const GUTF8String &) override {
    return true;
  }

 private:
  EvbDjVuDocumentState *state_;
};

std::unordered_map<int32_t, std::unique_ptr<EvbDjVuDocumentState>> g_docs;
int32_t g_next_handle = 1;

EvbDjVuDocumentState *get_doc(int32_t handle) {
  auto it = g_docs.find(handle);
  if (it == g_docs.end()) {
    set_error("Invalid DjVu document handle");
    return nullptr;
  }
  return it->second.get();
}

int32_t check_pending_state(EvbDjVuDocumentState *state) {
  if (state->limitExceeded) {
    state->limitExceeded = false;
    set_error("DjVu component exceeds maximum byte limit");
    return EVB_DJVU_ERR_OOM;
  }
  if (state->oomTriggered) {
    state->oomTriggered = false;
    set_error("Out of memory while reading DjVu component");
    return EVB_DJVU_ERR_OOM;
  }
  if (!state->needComponent.empty()) {
    g_missing_component = state->needComponent;
    state->needComponent.clear();
    return EVB_DJVU_NEED_COMPONENT;
  }
  return EVB_DJVU_OK;
}

GP<DjVmDir> safe_get_djvm_dir(DjVuDocument *doc) {
  if (!doc) {
    return nullptr;
  }
  const int docType = doc->get_doc_type();
  if (docType != DjVuDocument::BUNDLED && docType != DjVuDocument::INDIRECT) {
    return nullptr;
  }
  return doc->get_djvm_dir();
}

bool is_include_component(DjVmDir *dir, const std::string &name) {
  if (!dir) {
    return false;
  }
  GP<DjVmDir::File> f = dir->name_to_file(GUTF8String(name.c_str()));
  if (!f) {
    f = dir->id_to_file(GUTF8String(name.c_str()));
  }
  return f && f->is_include();
}

void evict_provided_components(EvbDjVuDocumentState *state, size_t maxBytes) {
  if (state->providedBytes <= maxBytes) {
    return;
  }
  GP<DjVmDir> dir = safe_get_djvm_dir(state->doc);
  // Pass 1: prefer evicting unpinned non-include (page) components oldest-first.
  // Pass 2: if still over budget, evict unpinned include (dictionary) components
  // oldest-first so dictionaries never bypass the cache budget permanently.
  for (int pass = 0; pass < 2 && state->providedBytes > maxBytes; ++pass) {
    const bool evictIncludes = (pass == 1);
    size_t idx = 0;
    while (idx < state->providedOrder.size() && state->providedBytes > maxBytes) {
      const std::string &name = state->providedOrder[idx];
      if (state->pinnedComponents.count(name) > 0) {
        ++idx;
        continue;
      }
      if (!evictIncludes && is_include_component(dir, name)) {
        ++idx;
        continue;
      }
      auto it = state->providedComponents.find(name);
      if (it != state->providedComponents.end()) {
        state->providedBytes -= it->second.size();
        state->providedComponents.erase(it);
      }
      state->providedOrder.erase(state->providedOrder.begin() + static_cast<ptrdiff_t>(idx));
    }
  }
}

struct PinnedComponentsGuard {
  EvbDjVuDocumentState *state;
  bool keepPinned = false;
  explicit PinnedComponentsGuard(EvbDjVuDocumentState *s) : state(s) {}
  ~PinnedComponentsGuard() {
    if (state && !keepPinned && !state->pinnedComponents.empty()) {
      state->pinnedComponents.clear();
      evict_provided_components(state, MAX_PROVIDED_COMPONENT_CACHE_BYTES);
    }
  }
};

GP<DjVuFile> get_page_file_raw(EvbDjVuDocumentState *state, int32_t pageIndex0) {
  if (!state->doc) {
    return nullptr;
  }
  int pages = state->doc->get_pages_num();
  if (pageIndex0 < 0 || pageIndex0 >= pages) {
    return nullptr;
  }
  return state->doc->get_djvu_file(pageIndex0);
}

GP<DjVuImage> decode_page_image(EvbDjVuDocumentState *state, int32_t pageIndex0) {
  if (!state->doc) {
    return nullptr;
  }
  int pages = state->doc->get_pages_num();
  if (pageIndex0 < 0 || pageIndex0 >= pages) {
    return nullptr;
  }
  return state->doc->get_page(pageIndex0, true);
}

// Convert GPixmap (bottom-up BGR) or GBitmap (bottom-up gray) to requested format,
// matching ddjvuapi.cpp's fmt_convert byte-for-byte.
int32_t convert_pixmap_to_output(GPixmap *pm, int32_t pixelFormat) {
  const int w = pm->columns();
  const int h = pm->rows();
  if (w <= 0 || h <= 0) {
    set_error("Rendered DjVu pixmap has empty dimensions");
    return EVB_DJVU_ERR_INVALID;
  }
  uint64_t rowSize = 0;
  if (pixelFormat == PIXEL_FORMAT_RGBA32) {
    rowSize = static_cast<uint64_t>(w) * 4ull;
  } else if (pixelFormat == PIXEL_FORMAT_RGB24) {
    rowSize = static_cast<uint64_t>(w) * 3ull;
  } else if (pixelFormat == PIXEL_FORMAT_PBM_MSB) {
    rowSize = (static_cast<uint64_t>(w) + 7ull) / 8ull;
  } else {
    set_error("Unsupported pixel format");
    return EVB_DJVU_ERR_INVALID;
  }
  uint64_t totalBytes = rowSize * static_cast<uint64_t>(h);
  if (totalBytes > MAX_RENDER_BUFFER_BYTES) {
    set_error("Rendered DjVu buffer exceeds allocation limit");
    return EVB_DJVU_ERR_OOM;
  }
  try {
    g_output.resize(static_cast<size_t>(totalBytes));
  } catch (const std::bad_alloc &) {
    set_error("Out of memory allocating rendered DjVu buffer");
    return EVB_DJVU_ERR_OOM;
  }

  uint8_t *dst = g_output.data();
  for (int r = h - 1; r >= 0; --r) {
    const GPixel *src = (*pm)[r];
    if (pixelFormat == PIXEL_FORMAT_RGBA32) {
      for (int x = 0; x < w; ++x) {
        dst[0] = src[x].r;
        dst[1] = src[x].g;
        dst[2] = src[x].b;
        dst[3] = 255;
        dst += 4;
      }
    } else if (pixelFormat == PIXEL_FORMAT_RGB24) {
      for (int x = 0; x < w; ++x) {
        dst[0] = src[x].r;
        dst[1] = src[x].g;
        dst[2] = src[x].b;
        dst += 3;
      }
    } else {
      // Exact threshold from ddjvuapi.cpp fmt_convert_row(GPixel*, DDJVU_FORMAT_MSBTOLSB)
      // with GPixel::WHITE (255,255,255):
      // t = (5*255 + 9*255 + 2*255 + 16) * 0xc / 0x10 = 3072
      constexpr int t = ((5 * 255 + 9 * 255 + 2 * 255 + 16) * 0xc) / 0x10;
      uint8_t s = 0;
      uint8_t m = 0x80;
      for (int x = 0; x < w; ++x) {
        if (5 * src[x].r + 9 * src[x].g + 2 * src[x].b < t) {
          s |= m;
        }
        m >>= 1;
        if (!m) {
          *dst++ = s;
          s = 0;
          m = 0x80;
        }
      }
      if (m != 0x80) {
        *dst++ = s;
      }
    }
  }
  g_render_width = w;
  g_render_height = h;
  g_render_present = 1;
  return EVB_DJVU_OK;
}

int32_t convert_bitmap_to_output(GBitmap *bm, int32_t pixelFormat) {
  const int w = bm->columns();
  const int h = bm->rows();
  const int m = bm->get_grays();
  if (w <= 0 || h <= 0 || m < 2) {
    set_error("Rendered DjVu bitmap has invalid dimensions");
    return EVB_DJVU_ERR_INVALID;
  }
  uint64_t rowSize = 0;
  if (pixelFormat == PIXEL_FORMAT_RGBA32) {
    rowSize = static_cast<uint64_t>(w) * 4ull;
  } else if (pixelFormat == PIXEL_FORMAT_RGB24) {
    rowSize = static_cast<uint64_t>(w) * 3ull;
  } else if (pixelFormat == PIXEL_FORMAT_PBM_MSB) {
    rowSize = (static_cast<uint64_t>(w) + 7ull) / 8ull;
  } else {
    set_error("Unsupported pixel format");
    return EVB_DJVU_ERR_INVALID;
  }
  uint64_t totalBytes = rowSize * static_cast<uint64_t>(h);
  if (totalBytes > MAX_RENDER_BUFFER_BYTES) {
    set_error("Rendered DjVu buffer exceeds allocation limit");
    return EVB_DJVU_ERR_OOM;
  }
  try {
    g_output.resize(static_cast<size_t>(totalBytes));
  } catch (const std::bad_alloc &) {
    set_error("Out of memory allocating rendered DjVu buffer");
    return EVB_DJVU_ERR_OOM;
  }

  // Exact gray ramp from ddjvuapi.cpp fmt_convert(GBitmap*) with GPixel::WHITE.
  uint8_t gray[256];
  for (int i = 0; i < m && i < 256; ++i) {
    gray[i] = static_cast<uint8_t>(255 - (i * 255 + (m - 1) / 2) / (m - 1));
  }
  for (int i = m; i < 256; ++i) {
    gray[i] = 0;
  }
  // Exact PBM threshold from ddjvuapi.cpp fmt_convert_row(unsigned char*, DDJVU_FORMAT_MSBTOLSB)
  constexpr int pbmThreshold = ((5 * 255 + 9 * 255 + 2 * 255 + 16) * 0xc) / 0x100;

  uint8_t *dst = g_output.data();
  for (int r = h - 1; r >= 0; --r) {
    const unsigned char *src = (*bm)[r];
    if (pixelFormat == PIXEL_FORMAT_RGBA32) {
      for (int x = 0; x < w; ++x) {
        uint8_t v = gray[src[x]];
        dst[0] = v;
        dst[1] = v;
        dst[2] = v;
        dst[3] = 255;
        dst += 4;
      }
    } else if (pixelFormat == PIXEL_FORMAT_RGB24) {
      for (int x = 0; x < w; ++x) {
        uint8_t v = gray[src[x]];
        dst[0] = v;
        dst[1] = v;
        dst[2] = v;
        dst += 3;
      }
    } else {
      uint8_t s = 0;
      uint8_t mask = 0x80;
      for (int x = 0; x < w; ++x) {
        if (gray[src[x]] < pbmThreshold) {
          s |= mask;
        }
        mask >>= 1;
        if (!mask) {
          *dst++ = s;
          s = 0;
          mask = 0x80;
        }
      }
      if (mask != 0x80) {
        *dst++ = s;
      }
    }
  }
  g_render_width = w;
  g_render_height = h;
  g_render_present = 1;
  return EVB_DJVU_OK;
}

void serialize_outline_range(
    DjVmNav *nav,
    int &pos,
    int count,
    int total,
    int depth,
    std::string &out) {
  out.push_back('[');
  bool first = true;
  for (int i = 0; i < count && pos < total; ++i) {
    GP<DjVmNav::DjVuBookMark> bm;
    if (!nav->getBookMark(bm, pos++) || !bm) {
      break;
    }
    if (!first) {
      out.push_back(',');
    }
    first = false;
    out += "{\"title\":";
    append_json_escaped(out, bm->displayname);
    out += ",\"url\":";
    append_json_escaped(out, bm->url);
    out += ",\"children\":";
    if (bm->count > 0 && depth < 128) {
      serialize_outline_range(nav, pos, bm->count, total, depth + 1, out);
    } else {
      out += "[]";
    }
    out.push_back('}');
  }
  out.push_back(']');
}

const char *zone_type_name(DjVuTXT::ZoneType ztype) {
  switch (ztype) {
    case DjVuTXT::PAGE: return "page";
    case DjVuTXT::COLUMN: return "column";
    case DjVuTXT::REGION: return "region";
    case DjVuTXT::PARAGRAPH: return "paragraph";
    case DjVuTXT::LINE: return "line";
    case DjVuTXT::WORD: return "word";
    case DjVuTXT::CHARACTER: return "char";
    default: return "zone";
  }
}

char zone_separator(DjVuTXT::ZoneType ztype) {
  switch (ztype) {
    case DjVuTXT::COLUMN: return DjVuTXT::end_of_column;
    case DjVuTXT::REGION: return DjVuTXT::end_of_region;
    case DjVuTXT::PARAGRAPH: return DjVuTXT::end_of_paragraph;
    case DjVuTXT::LINE: return DjVuTXT::end_of_line;
    case DjVuTXT::WORD: return ' ';
    default: return 0;
  }
}

void collect_leaf_zones(
    const DjVuTXT *txt,
    const DjVuTXT::Zone &zone,
    int32_t currentLineId,
    int32_t &nextLineId,
    std::string &out,
    bool &first,
    size_t &zoneCount,
    size_t maxZones,
    int depth = 0) {
  if (zoneCount >= maxZones || depth > MAX_TEXT_ZONE_DEPTH) {
    return;
  }
  int32_t lineId = currentLineId;
  if (zone.ztype == DjVuTXT::LINE) {
    lineId = ++nextLineId;
  }
  bool isLeaf = zone.children.isempty() || zone.ztype == DjVuTXT::WORD;
  if (isLeaf) {
    const char *fullText = static_cast<const char *>(txt->textUTF8);
    int fullLen = txt->textUTF8.length();
    int start = std::max(0, std::min(zone.text_start, fullLen));
    int len = std::max(0, std::min(zone.text_length, fullLen - start));
    char sep = zone_separator(zone.ztype);
    if (len > 0 && fullText && sep != 0 && fullText[start + len - 1] == sep) {
      len -= 1;
    }
    if (len > 0 && fullText) {
      if (!first) {
        out.push_back(',');
      }
      first = false;
      ++zoneCount;
      char coords[160];
      std::snprintf(
          coords,
          sizeof(coords),
          "{\"type\":\"%s\",\"lineId\":%d,\"xmin\":%d,\"ymin\":%d,\"xmax\":%d,\"ymax\":%d,\"text\":",
          zone_type_name(zone.ztype),
          lineId,
          zone.rect.xmin,
          zone.rect.ymin,
          zone.rect.xmax,
          zone.rect.ymax);
      out += coords;
      append_json_escaped(out, fullText + start, static_cast<size_t>(len));
      out.push_back('}');
    }
    return;
  }
  for (GPosition pos = zone.children; pos; ++pos) {
    collect_leaf_zones(txt, zone.children[pos], lineId, nextLineId, out, first, zoneCount, maxZones, depth + 1);
  }
}

// Fast IFF scan of a page component for TXTa/TXTz chunks without decoding images.
GP<DjVuTXT> extract_text_from_pool_fast(const GP<DataPool> &pool) {
  if (!pool) {
    return nullptr;
  }
  GP<ByteStream> bs = pool->get_stream();
  if (!bs) {
    return nullptr;
  }
  GP<IFFByteStream> iff = IFFByteStream::create(bs);
  GUTF8String chkid;
  if (!iff->get_chunk(chkid)) {
    return nullptr;
  }
  if (chkid != "FORM:DJVU" && chkid != "FORM:BM44" && chkid != "FORM:PM44") {
    return nullptr;
  }
  while (iff->get_chunk(chkid)) {
    if (chkid == "TXTa" || chkid == "TXTz") {
      GP<ByteStream> chunkStream = iff->get_bytestream();
      GP<ByteStream> txtStream = (chkid == "TXTz")
          ? BSByteStream::create(chunkStream)
          : chunkStream;
      GP<DjVuTXT> txt = DjVuTXT::create();
      txt->decode(txtStream);
      iff->close_chunk();
      return txt;
    }
    iff->close_chunk();
  }
  return nullptr;
}

bool is_whitespace_only(const GUTF8String &s) {
  const char *p = static_cast<const char *>(s);
  if (!p) return true;
  while (*p) {
    unsigned char ch = static_cast<unsigned char>(*p++);
    if (ch > 0x20) return false;
  }
  return true;
}

struct ChunkLayerInfo {
  bool present = false;
  std::string kind;
  uint64_t bytes = 0;
  int width = 0;
  int height = 0;
};

struct PageHeaderInfo {
  bool validForm = false;
  bool hasInfo = false;
  int rawWidth = 0;
  int rawHeight = 0;
  int width = 0;
  int height = 0;
  int dpi = 300;
  int rotation = 0;
  uint64_t pageBytes = 0;
  bool hasMask = false;
  bool hasSjbzMask = false;
  uint64_t maskBytes = 0;
  bool hasBg = false;
  bool hasFg = false;
  ChunkLayerInfo bg;
  ChunkLayerInfo fg;
  int maxLayerWidth = 0;
  int maxLayerHeight = 0;
  uint64_t maxLayerPixels = 0;
};

bool parse_iw44_header_dimensions(const uint8_t *hdr, size_t len, int &width, int &height) {
  if (len < 8) {
    return false;
  }
  if (hdr[0] != 0 || (hdr[2] & 0x7f) != 1 || hdr[3] > 2) {
    return false;
  }
  width = read_be16(hdr + 4);
  height = read_be16(hdr + 6);
  return width > 0 && height > 0;
}

void record_layer_dims(PageHeaderInfo &out, int w, int h) {
  if (w <= 0 || h <= 0) {
    return;
  }
  out.maxLayerWidth = std::max(out.maxLayerWidth, w);
  out.maxLayerHeight = std::max(out.maxLayerHeight, h);
  uint64_t pixels = static_cast<uint64_t>(w) * static_cast<uint64_t>(h);
  out.maxLayerPixels = std::max(out.maxLayerPixels, pixels);
}

bool inspect_page_header_from_pool(const GP<DataPool> &pool, PageHeaderInfo &out, bool inspectLayerDimensions) {
  if (!pool) {
    return false;
  }
  out.pageBytes = static_cast<uint64_t>(std::max(0, pool->get_size()));
  GP<ByteStream> bs = pool->get_stream();
  if (!bs) {
    return false;
  }
  GP<IFFByteStream> iff = IFFByteStream::create(bs);
  GUTF8String chkid;
  if (iff->get_chunk(chkid) <= 0) {
    return false;
  }
  const bool isDjvu = (chkid == "FORM:DJVU");
  const bool isIw44 = (chkid == "FORM:BM44" || chkid == "FORM:PM44");
  if (!isDjvu && !isIw44) {
    return false;
  }
  out.validForm = true;

  int chunkSize = 0;
  while ((chunkSize = iff->get_chunk(chkid)) > 0) {
    const std::string id(static_cast<const char *>(chkid));
    if (isDjvu && id == "INFO") {
      GP<DjVuInfo> info = DjVuInfo::create();
      info->decode(*iff->get_bytestream());
      out.rawWidth = info->width;
      out.rawHeight = info->height;
      out.rotation = orientation_to_degrees(info->orientation);
      out.width = (out.rotation == 90 || out.rotation == 270) ? info->height : info->width;
      out.height = (out.rotation == 90 || out.rotation == 270) ? info->width : info->height;
      out.dpi = (info->dpi >= 25 && info->dpi <= 6000) ? info->dpi : 300;
      out.hasInfo = (out.width > 0 && out.height > 0);
    } else if (isDjvu && (id == "Sjbz" || id == "Smmr")) {
      out.hasMask = true;
      if (id == "Sjbz") {
        out.hasSjbzMask = true;
        out.maskBytes += static_cast<uint64_t>(chunkSize);
      }
    } else if ((isIw44 && (id == "BM44" || id == "PM44"))
               || (isDjvu && (id == "BG44" || id == "BGjp" || id == "BG2k" || id == "PM44" || id == "BM44"))) {
      out.hasBg = true;
      out.bg.present = true;
      if (out.bg.kind.empty()) out.bg.kind = id;
      out.bg.bytes += static_cast<uint64_t>(chunkSize);
      if ((id == "BG44" || id == "PM44" || id == "BM44") && chunkSize >= 8 && (isIw44 || inspectLayerDimensions)) {
        uint8_t hdr[8];
        if (iff->get_bytestream()->readall(hdr, 8) == 8) {
          int iwW = 0;
          int iwH = 0;
          if (parse_iw44_header_dimensions(hdr, sizeof(hdr), iwW, iwH)) {
            if (out.bg.width == 0) {
              out.bg.width = iwW;
              out.bg.height = iwH;
            }
            record_layer_dims(out, iwW, iwH);
            if (isIw44 && !out.hasInfo) {
              out.rawWidth = iwW;
              out.rawHeight = iwH;
              out.width = iwW;
              out.height = iwH;
              out.dpi = 100;
              out.rotation = 0;
              out.hasInfo = true;
            }
          }
        }
      } else if (id == "BGjp" && inspectLayerDimensions && out.bg.width == 0 && chunkSize >= 4) {
        GP<ByteStream> jpegStream = iff->get_bytestream();
        if (jpegStream && parse_jpeg_dimensions_from_stream(*jpegStream, chunkSize, out.bg.width, out.bg.height)) {
          record_layer_dims(out, out.bg.width, out.bg.height);
        }
      }
    } else if (isDjvu && (id == "FG44" || id == "FGbz" || id == "FGjp" || id == "FG2k")) {
      out.hasFg = true;
      out.fg.present = true;
      if (out.fg.kind.empty()) out.fg.kind = id;
      out.fg.bytes += static_cast<uint64_t>(chunkSize);
      if (id == "FG44" && inspectLayerDimensions && out.fg.width == 0 && chunkSize >= 8) {
        uint8_t hdr[8];
        if (iff->get_bytestream()->readall(hdr, 8) == 8) {
          int iwW = 0;
          int iwH = 0;
          if (parse_iw44_header_dimensions(hdr, sizeof(hdr), iwW, iwH)) {
            out.fg.width = iwW;
            out.fg.height = iwH;
            record_layer_dims(out, iwW, iwH);
          }
        }
      } else if (id == "FGjp" && inspectLayerDimensions && out.fg.width == 0 && chunkSize >= 4) {
        GP<ByteStream> jpegStream = iff->get_bytestream();
        if (jpegStream && parse_jpeg_dimensions_from_stream(*jpegStream, chunkSize, out.fg.width, out.fg.height)) {
          record_layer_dims(out, out.fg.width, out.fg.height);
        }
      }
    }
    iff->close_chunk();
  }
  return true;
}

bool compute_output_row_bytes(int w, int32_t pixelFormat, uint64_t &rowSize) {
  if (w <= 0) {
    return false;
  }
  if (pixelFormat == PIXEL_FORMAT_RGBA32) {
    rowSize = static_cast<uint64_t>(w) * 4ull;
    return true;
  }
  if (pixelFormat == PIXEL_FORMAT_RGB24) {
    rowSize = static_cast<uint64_t>(w) * 3ull;
    return true;
  }
  if (pixelFormat == PIXEL_FORMAT_PBM_MSB) {
    rowSize = (static_cast<uint64_t>(w) + 7ull) / 8ull;
    return true;
  }
  return false;
}

int32_t validate_native_dimensions(int width, int height) {
  if (width <= 0 || height <= 0) {
    set_error("DjVu page has invalid dimensions");
    return EVB_DJVU_ERR_INVALID;
  }
  uint64_t pixels = static_cast<uint64_t>(width) * static_cast<uint64_t>(height);
  if (width > MAX_NATIVE_PAGE_DIM || height > MAX_NATIVE_PAGE_DIM || pixels > MAX_NATIVE_PAGE_PIXELS) {
    set_error("DjVu page native dimensions exceed allocation limit");
    return EVB_DJVU_ERR_OOM;
  }
  return EVB_DJVU_OK;
}

int32_t validate_render_dimensions(
    int targetFullW,
    int targetFullH,
    int rx,
    int ry,
    int rw,
    int rh,
    int32_t mode,
    int32_t pixelFormat) {
  if (targetFullW <= 0 || targetFullH <= 0 || rw <= 0 || rh <= 0 || rx < 0 || ry < 0) {
    set_error("Render rectangle out of bounds");
    return EVB_DJVU_ERR_BOUNDS;
  }
  if (static_cast<int64_t>(rx) + static_cast<int64_t>(rw) > static_cast<int64_t>(targetFullW)
      || static_cast<int64_t>(ry) + static_cast<int64_t>(rh) > static_cast<int64_t>(targetFullH)) {
    set_error("Render rectangle out of bounds");
    return EVB_DJVU_ERR_BOUNDS;
  }
  if (rw > MAX_RENDER_DIM || rh > MAX_RENDER_DIM) {
    set_error("Requested DjVu render dimensions exceed allocation limit");
    return EVB_DJVU_ERR_OOM;
  }
  const uint64_t pixels = static_cast<uint64_t>(rw) * static_cast<uint64_t>(rh);
  if (pixels > MAX_RENDER_PIXELS) {
    set_error("Requested DjVu render pixel count exceeds allocation limit");
    return EVB_DJVU_ERR_OOM;
  }
  uint64_t rowSize = 0;
  if (!compute_output_row_bytes(rw, pixelFormat, rowSize)) {
    set_error("Unsupported pixel format");
    return EVB_DJVU_ERR_INVALID;
  }
  const uint64_t outputBytes = rowSize * static_cast<uint64_t>(rh);
  const uint64_t intermediateBpp = (mode == RENDER_MODE_MASKONLY) ? 1ull : 3ull;
  const uint64_t intermediateBytes = pixels * intermediateBpp;
  if (outputBytes > MAX_RENDER_BUFFER_BYTES || intermediateBytes > MAX_RENDER_BUFFER_BYTES) {
    set_error("Requested DjVu render buffer exceeds allocation limit");
    return EVB_DJVU_ERR_OOM;
  }
  return EVB_DJVU_OK;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_open(int32_t docId, const uint8_t *initPtr, int32_t initLen, uint32_t cacheBytes) {
  clear_call_state();
  if (!initPtr || initLen <= 0) {
    set_error("Empty DjVu input");
    return 0;
  }
  if (static_cast<size_t>(initLen) > MAX_INIT_BYTES) {
    set_error("DjVu input exceeds maximum byte limit");
    return 0;
  }
  try {
    int32_t handle = g_next_handle++;
    auto state = std::make_unique<EvbDjVuDocumentState>();
    state->docId = docId;
    state->initBytes.assign(initPtr, initPtr + initLen);
    char initUrlBuf[96];
    std::snprintf(
        initUrlBuf,
        sizeof(initUrlBuf),
        "evb://doc-%d/__evb_djvulibre_index_%d__",
        handle,
        handle);
    state->initUrl = GURL::UTF8(initUrlBuf);

    uint32_t clampedCache = std::max(MIN_CACHE_BYTES, std::min(cacheBytes, MAX_CACHE_BYTES));
    state->cache = DjVuFileCache::create(static_cast<int>(clampedCache));

    state->port = new EvbDjVuPort(state.get());
    state->doc = DjVuDocument::create_noinit();
    state->doc->init(state->initUrl, state->port, state->cache);
    state->initDone = true;

    if (!state->doc->is_init_ok()) {
      set_error("DjVu document failed to initialize");
      return 0;
    }
    if (state->doc->get_pages_num() <= 0) {
      set_error("DjVu document contains no pages");
      return 0;
    }

    g_docs.emplace(handle, std::move(state));
    return handle;
  } catch (const GException &ex) {
    set_error(ex.get_cause() ? ex.get_cause() : "DjVu open failed");
    return 0;
  } catch (const std::bad_alloc &) {
    set_error("Out of memory opening DjVu document");
    return 0;
  } catch (const std::exception &ex) {
    set_error(ex.what());
    return 0;
  } catch (...) {
    set_error("Unknown error opening DjVu document");
    return 0;
  }
}

EMSCRIPTEN_KEEPALIVE
void evb_djvu_close(int32_t handle) {
  clear_call_state();
  g_docs.erase(handle);
}

EMSCRIPTEN_KEEPALIVE
void evb_djvu_clear_cache(int32_t handle) {
  auto it = g_docs.find(handle);
  if (it == g_docs.end()) {
    return;
  }
  auto *state = it->second.get();
  if (state->cache) {
    state->cache->clear();
  }
  state->providedComponents.clear();
  state->pinnedComponents.clear();
  state->providedOrder.clear();
  state->providedBytes = 0;
}

EMSCRIPTEN_KEEPALIVE
void evb_djvu_unpin_components(int32_t handle) {
  auto it = g_docs.find(handle);
  if (it == g_docs.end()) {
    return;
  }
  auto *state = it->second.get();
  if (!state->pinnedComponents.empty()) {
    state->pinnedComponents.clear();
    evict_provided_components(state, MAX_PROVIDED_COMPONENT_CACHE_BYTES);
  }
}

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_provide_component(
    int32_t handle,
    const char *namePtr,
    int32_t nameLen,
    const uint8_t *dataPtr,
    int32_t dataLen) {
  clear_call_state();
  auto *state = get_doc(handle);
  if (!state) return EVB_DJVU_ERR_INVALID;
  if (!namePtr || nameLen <= 0 || !dataPtr || dataLen < 0) {
    set_error("Invalid component arguments");
    return EVB_DJVU_ERR_INVALID;
  }
  const size_t newLen = static_cast<size_t>(dataLen);
  if (newLen > MAX_COMPONENT_BYTES) {
    set_error("DjVu component exceeds maximum byte limit");
    return EVB_DJVU_ERR_OOM;
  }
  try {
    std::string name(namePtr, static_cast<size_t>(nameLen));
    auto existing = state->providedComponents.find(name);
    const size_t existingLen = (existing != state->providedComponents.end()) ? existing->second.size() : 0;
    const size_t netIncrease = newLen > existingLen ? (newLen - existingLen) : 0;
    if (netIncrease > 0) {
      const size_t targetBytes = (MAX_PROVIDED_COMPONENT_CACHE_BYTES > netIncrease)
          ? (MAX_PROVIDED_COMPONENT_CACHE_BYTES - netIncrease)
          : 0;
      evict_provided_components(state, targetBytes);
      existing = state->providedComponents.find(name);
    }
    if (existing != state->providedComponents.end()) {
      state->providedBytes -= existing->second.size();
      existing->second.assign(dataPtr, dataPtr + newLen);
      state->providedBytes += existing->second.size();
      auto orderIt = std::find(state->providedOrder.begin(), state->providedOrder.end(), name);
      if (orderIt != state->providedOrder.end()) {
        state->providedOrder.erase(orderIt);
      }
      state->providedOrder.push_back(name);
    } else {
      std::vector<uint8_t> buf(dataPtr, dataPtr + newLen);
      state->providedBytes += buf.size();
      state->providedComponents.emplace(name, std::move(buf));
      state->providedOrder.push_back(name);
    }
    state->pinnedComponents.insert(name);
    evict_provided_components(state, MAX_PROVIDED_COMPONENT_CACHE_BYTES);
    return EVB_DJVU_OK;
  } catch (const std::bad_alloc &) {
    set_error("Out of memory storing DjVu component");
    return EVB_DJVU_ERR_OOM;
  }
}

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_get_doc_info(int32_t handle) {
  clear_call_state();
  auto *state = get_doc(handle);
  if (!state) return EVB_DJVU_ERR_INVALID;
  try {
    const int pageCount = state->doc->get_pages_num();
    const int rawType = state->doc->get_doc_type();
    const char *docType = "unknown";
    switch (rawType) {
      case DjVuDocument::SINGLE_PAGE: docType = "single"; break;
      case DjVuDocument::BUNDLED: docType = "bundled"; break;
      case DjVuDocument::INDIRECT: docType = "indirect"; break;
      case DjVuDocument::OLD_BUNDLED: docType = "old-bundled"; break;
      case DjVuDocument::OLD_INDEXED: docType = "old-indexed"; break;
      default: break;
    }
    GP<DjVmNav> nav = state->doc->get_djvm_nav();
    const bool hasOutline = nav && nav->getBookMarkCount() > 0;

    std::string json;
    json.reserve(512);
    char head[160];
    std::snprintf(
        head,
        sizeof(head),
        "{\"pageCount\":%d,\"docType\":\"%s\",\"hasOutline\":%s,\"files\":[",
        pageCount,
        docType,
        hasOutline ? "true" : "false");
    json += head;

    GP<DjVmDir> dir = safe_get_djvm_dir(state->doc);
    if (dir) {
      GPList<DjVmDir::File> list = dir->get_files_list();
      bool first = true;
      int pageNum = 0;
      for (GPosition pos = list; pos; ++pos) {
        GP<DjVmDir::File> f = list[pos];
        if (!f) continue;
        if (!first) json.push_back(',');
        first = false;
        const char *ftype = "include";
        int pno = -1;
        if (f->is_page()) {
          ftype = "page";
          pno = ++pageNum;
        } else if (f->is_thumbnails()) {
          ftype = "thumbnail";
        } else if (f->is_shared_anno()) {
          ftype = "shared-anno";
        }
        json += "{\"id\":";
        append_json_escaped(json, f->get_load_name());
        json += ",\"name\":";
        append_json_escaped(json, f->get_save_name());
        json += ",\"title\":";
        append_json_escaped(json, f->get_title());
        json += ",\"type\":\"";
        json += ftype;
        json += "\",\"pageNumber\":";
        if (pno > 0) {
          char nbuf[24];
          std::snprintf(nbuf, sizeof(nbuf), "%d", pno);
          json += nbuf;
        } else {
          json += "null";
        }
        char sbuf[32];
        std::snprintf(sbuf, sizeof(sbuf), ",\"size\":%d}", f->size);
        json += sbuf;
      }
    } else if (rawType == DjVuDocument::OLD_BUNDLED) {
      GP<DjVmDir0> dir0 = state->doc->get_djvm_dir0();
      bool first = true;
      std::unordered_set<std::string> emittedPages;
      for (int p = 0; p < pageCount; ++p) {
        GUTF8String pid = state->doc->page_to_id(p);
        std::string pidStr(static_cast<const char *>(pid));
        emittedPages.insert(pidStr);
        int fsize = 0;
        if (dir0) {
          GP<DjVmDir0::FileRec> frec = dir0->get_file(pid);
          if (frec && frec->size > 0) {
            fsize = frec->size;
          }
        }
        if (!first) json.push_back(',');
        first = false;
        json += "{\"id\":";
        append_json_escaped(json, pid);
        json += ",\"name\":";
        append_json_escaped(json, pid);
        json += ",\"title\":\"\",\"type\":\"page\",\"pageNumber\":";
        char nbuf[48];
        std::snprintf(nbuf, sizeof(nbuf), "%d,\"size\":%d}", p + 1, fsize);
        json += nbuf;
      }
      if (dir0) {
        const int totalFiles = dir0->get_files_num();
        for (int i = 0; i < totalFiles; ++i) {
          GP<DjVmDir0::FileRec> frec = dir0->get_file(i);
          if (!frec) continue;
          std::string fnameStr(static_cast<const char *>(frec->name));
          if (emittedPages.count(fnameStr) > 0) continue;
          if (!first) json.push_back(',');
          first = false;
          json += "{\"id\":";
          append_json_escaped(json, frec->name);
          json += ",\"name\":";
          append_json_escaped(json, frec->name);
          json += ",\"title\":\"\",\"type\":\"include\",\"pageNumber\":null,\"size\":";
          char sbuf[32];
          std::snprintf(sbuf, sizeof(sbuf), "%d}", std::max(0, frec->size));
          json += sbuf;
        }
      }
    }
    json += "]}";
    set_output_string(json);
    return EVB_DJVU_OK;
  } catch (const GException &ex) {
    set_error(ex.get_cause() ? ex.get_cause() : "Failed to read DjVu document info");
    return EVB_DJVU_ERR_INVALID;
  } catch (const std::exception &ex) {
    set_error(ex.what());
    return EVB_DJVU_ERR_INTERNAL;
  }
}

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_get_page_info(int32_t handle, int32_t pageIndex0) {
  clear_call_state();
  auto *state = get_doc(handle);
  if (!state) return EVB_DJVU_ERR_INVALID;
  PinnedComponentsGuard pinGuard(state);
  state->needComponent.clear();
  state->oomTriggered = false;
  state->limitExceeded = false;
  try {
    const int pages = state->doc->get_pages_num();
    if (pageIndex0 < 0 || pageIndex0 >= pages) {
      set_error("Page index out of bounds");
      return EVB_DJVU_ERR_BOUNDS;
    }
    GP<DjVuFile> file = get_page_file_raw(state, pageIndex0);
    int32_t pending = check_pending_state(state);
    if (pending != EVB_DJVU_OK) {
      pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
      return pending;
    }
    if (!file) {
      set_error("Failed to open DjVu page file");
      return EVB_DJVU_ERR_INVALID;
    }
    GP<DataPool> pool = file->get_init_data_pool();
    if (!pool) {
      set_error("DjVu page has no data");
      return EVB_DJVU_ERR_INVALID;
    }
    PageHeaderInfo header;
    if (!inspect_page_header_from_pool(pool, header, false) || !header.validForm) {
      set_error("DjVu page is not a FORM:DJVU, FORM:BM44, or FORM:PM44 stream");
      return EVB_DJVU_ERR_INVALID;
    }
    if (!header.hasInfo || header.width <= 0 || header.height <= 0) {
      set_error("DjVu page is missing a valid INFO or IW44 header");
      return EVB_DJVU_ERR_INVALID;
    }
    const char *pageType = "unknown";
    if (header.hasMask && (header.hasBg || header.hasFg)) {
      pageType = "compound";
    } else if (header.hasMask) {
      pageType = "bitonal";
    } else if (header.hasBg) {
      pageType = "photo";
    }
    char json[256];
    std::snprintf(
        json,
        sizeof(json),
        "{\"width\":%d,\"height\":%d,\"rawWidth\":%d,\"rawHeight\":%d,\"dpi\":%d,\"rotation\":%d,\"pageType\":\"%s\"}",
        header.width,
        header.height,
        header.rawWidth,
        header.rawHeight,
        header.dpi,
        header.rotation,
        pageType);
    set_output_string(json);
    return EVB_DJVU_OK;
  } catch (const GException &ex) {
    int32_t pending = check_pending_state(state);
    if (pending != EVB_DJVU_OK) {
      pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
      return pending;
    }
    set_error(ex.get_cause() ? ex.get_cause() : "Failed to inspect DjVu page");
    return EVB_DJVU_ERR_INVALID;
  } catch (const std::bad_alloc &) {
    set_error("Out of memory inspecting DjVu page");
    return EVB_DJVU_ERR_OOM;
  } catch (const std::exception &ex) {
    set_error(ex.what());
    return EVB_DJVU_ERR_INTERNAL;
  }
}

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_get_page_structure(int32_t handle, int32_t pageIndex0) {
  clear_call_state();
  auto *state = get_doc(handle);
  if (!state) return EVB_DJVU_ERR_INVALID;
  PinnedComponentsGuard pinGuard(state);
  state->needComponent.clear();
  state->oomTriggered = false;
  state->limitExceeded = false;
  try {
    const int pages = state->doc->get_pages_num();
    if (pageIndex0 < 0 || pageIndex0 >= pages) {
      set_error("Page index out of bounds");
      return EVB_DJVU_ERR_BOUNDS;
    }
    GP<DjVuFile> file = get_page_file_raw(state, pageIndex0);
    int32_t pending = check_pending_state(state);
    if (pending != EVB_DJVU_OK) {
      pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
      return pending;
    }
    if (!file) {
      set_error("Failed to open DjVu page file");
      return EVB_DJVU_ERR_INVALID;
    }
    GP<DataPool> pool = file->get_init_data_pool();
    if (!pool) {
      set_error("DjVu page has no data");
      return EVB_DJVU_ERR_INVALID;
    }
    PageHeaderInfo header;
    if (!inspect_page_header_from_pool(pool, header, true) || !header.validForm) {
      set_error("DjVu page is not a FORM:DJVU, FORM:BM44, or FORM:PM44 stream");
      return EVB_DJVU_ERR_INVALID;
    }

    auto appendLayer = [](std::string &out, const ChunkLayerInfo &layer) {
      if (!layer.present) {
        out += "null";
        return;
      }
      out += "{\"present\":true,\"kind\":";
      append_json_escaped(out, layer.kind);
      char buf[128];
      if (layer.width > 0 && layer.height > 0) {
        std::snprintf(
            buf,
            sizeof(buf),
            ",\"bytes\":%llu,\"width\":%d,\"height\":%d}",
            static_cast<unsigned long long>(layer.bytes),
            layer.width,
            layer.height);
      } else {
        std::snprintf(
            buf,
            sizeof(buf),
            ",\"bytes\":%llu,\"width\":null,\"height\":null}",
            static_cast<unsigned long long>(layer.bytes));
      }
      out += buf;
    };

    std::string json;
    json.reserve(384);
    char head[192];
    std::snprintf(
        head,
        sizeof(head),
        "{\"pageNumber\":%d,\"pageBytes\":%llu,\"rotation\":%d,",
        pageIndex0 + 1,
        static_cast<unsigned long long>(header.pageBytes),
        header.rotation);
    json += head;
    if (header.hasInfo && header.width > 0 && header.height > 0) {
      char ibuf[128];
      std::snprintf(
          ibuf,
          sizeof(ibuf),
          "\"info\":{\"width\":%d,\"height\":%d,\"dpi\":%d},",
          header.width,
          header.height,
          header.dpi);
      json += ibuf;
    } else {
      json += "\"info\":null,";
    }
    char mbuf[96];
    if (header.hasSjbzMask) {
      std::snprintf(
          mbuf,
          sizeof(mbuf),
          "\"hasMask\":true,\"maskBytes\":%llu,",
          static_cast<unsigned long long>(header.maskBytes));
    } else {
      std::snprintf(mbuf, sizeof(mbuf), "\"hasMask\":false,\"maskBytes\":null,");
    }
    json += mbuf;
    json += "\"background\":";
    appendLayer(json, header.bg);
    json += ",\"foreground\":";
    appendLayer(json, header.fg);
    json.push_back('}');

    set_output_string(json);
    return EVB_DJVU_OK;
  } catch (const GException &ex) {
    int32_t pending = check_pending_state(state);
    if (pending != EVB_DJVU_OK) {
      pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
      return pending;
    }
    set_error(ex.get_cause() ? ex.get_cause() : "Failed to inspect DjVu page structure");
    return EVB_DJVU_ERR_INVALID;
  } catch (const std::bad_alloc &) {
    set_error("Out of memory inspecting DjVu page structure");
    return EVB_DJVU_ERR_OOM;
  } catch (const std::exception &ex) {
    set_error(ex.what());
    return EVB_DJVU_ERR_INTERNAL;
  }
}

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_render_page(
    int32_t handle,
    int32_t pageIndex0,
    int32_t mode,
    int32_t pixelFormat,
    int32_t fullW,
    int32_t fullH,
    int32_t rectX,
    int32_t rectY,
    int32_t rectW,
    int32_t rectH) {
  clear_call_state();
  auto *state = get_doc(handle);
  if (!state) return EVB_DJVU_ERR_INVALID;
  PinnedComponentsGuard pinGuard(state);
  state->needComponent.clear();
  state->oomTriggered = false;
  state->limitExceeded = false;
  try {
    if (mode < RENDER_MODE_COLOR || mode > RENDER_MODE_FOREGROUND) {
      set_error("Unsupported DjVu render mode");
      return EVB_DJVU_ERR_INVALID;
    }
    if (pixelFormat < PIXEL_FORMAT_RGBA32 || pixelFormat > PIXEL_FORMAT_PBM_MSB) {
      set_error("Unsupported pixel format");
      return EVB_DJVU_ERR_INVALID;
    }
    const int pages = state->doc->get_pages_num();
    if (pageIndex0 < 0 || pageIndex0 >= pages) {
      set_error("Page index out of bounds");
      return EVB_DJVU_ERR_BOUNDS;
    }

    // Validate explicitly requested target/rect dimensions before fetching or decoding the page.
    if (fullW < 0 || fullH < 0 || rectX < 0 || rectY < 0 || rectW < 0 || rectH < 0) {
      set_error("Render rectangle out of bounds");
      return EVB_DJVU_ERR_BOUNDS;
    }
    if (fullW > 0 && fullH > 0) {
      const int preRw = rectW > 0 ? rectW : fullW;
      const int preRh = rectH > 0 ? rectH : fullH;
      const int32_t preCheck = validate_render_dimensions(
          fullW, fullH, rectX, rectY, preRw, preRh, mode, pixelFormat);
      if (preCheck != EVB_DJVU_OK) {
        return preCheck;
      }
    } else if (rectW > 0 && rectH > 0) {
      const int32_t preCheck = validate_render_dimensions(
          rectW, rectH, 0, 0, rectW, rectH, mode, pixelFormat);
      if (preCheck != EVB_DJVU_OK) {
        return preCheck;
      }
    }

    // Inspect raw page header BEFORE decoding JB2/IW44/JPEG layers to reject oversized pages early.
    GP<DjVuFile> rawFile = get_page_file_raw(state, pageIndex0);
    int32_t pending = check_pending_state(state);
    if (pending != EVB_DJVU_OK) {
      pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
      return pending;
    }
    if (!rawFile) {
      set_error("Failed to open DjVu page file");
      return EVB_DJVU_ERR_INVALID;
    }
    PageHeaderInfo preHeader;
    if (inspect_page_header_from_pool(rawFile->get_init_data_pool(), preHeader, true)) {
      if (preHeader.hasInfo) {
        const int32_t nativeCheck = validate_native_dimensions(preHeader.width, preHeader.height);
        if (nativeCheck != EVB_DJVU_OK) {
          return nativeCheck;
        }
        const int preFullW = fullW > 0 ? fullW : preHeader.width;
        const int preFullH = fullH > 0 ? fullH : preHeader.height;
        const int preRw = rectW > 0 ? rectW : preFullW;
        const int preRh = rectH > 0 ? rectH : preFullH;
        const int32_t targetCheck = validate_render_dimensions(
            preFullW, preFullH, rectX, rectY, preRw, preRh, mode, pixelFormat);
        if (targetCheck != EVB_DJVU_OK) {
          return targetCheck;
        }
      }
      if (preHeader.maxLayerWidth > MAX_NATIVE_PAGE_DIM
          || preHeader.maxLayerHeight > MAX_NATIVE_PAGE_DIM
          || preHeader.maxLayerPixels > MAX_NATIVE_PAGE_PIXELS) {
        set_error("DjVu page layer dimensions exceed allocation limit");
        return EVB_DJVU_ERR_OOM;
      }
    }

    GP<DjVuImage> img = decode_page_image(state, pageIndex0);
    pending = check_pending_state(state);
    if (pending != EVB_DJVU_OK) {
      // Clear any half-decoded file from cache before retrying with the fetched component.
      if (state->cache) state->cache->clear();
      pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
      return pending;
    }
    if (!img) {
      set_error("Failed to decode DjVu page");
      return EVB_DJVU_ERR_INVALID;
    }
    GP<DjVuFile> dfile = img->get_djvu_file();
    if (!dfile || !dfile->is_decode_ok()) {
      set_error("DjVu page decode failed (corrupt or truncated stream)");
      return EVB_DJVU_ERR_INVALID;
    }

    const int nativeW = img->get_width();
    const int nativeH = img->get_height();
    const int32_t decodedNativeCheck = validate_native_dimensions(nativeW, nativeH);
    if (decodedNativeCheck != EVB_DJVU_OK) {
      return decodedNativeCheck;
    }

    int targetFullW = fullW > 0 ? fullW : nativeW;
    int targetFullH = fullH > 0 ? fullH : nativeH;
    int rx = rectX >= 0 ? rectX : 0;
    int ry = rectY >= 0 ? rectY : 0;
    int rw = rectW > 0 ? rectW : targetFullW;
    int rh = rectH > 0 ? rectH : targetFullH;

    const int32_t targetCheck = validate_render_dimensions(
        targetFullW, targetFullH, rx, ry, rw, rh, mode, pixelFormat);
    if (targetCheck != EVB_DJVU_OK) {
      return targetCheck;
    }

    // Top-to-bottom rectangle mapping matching ddjvu_page_render (ytoptobottom = true).
    GRect prect(0, 0, targetFullW, targetFullH);
    GRect rrect(rx, ry, rw, rh);
    prect.ymin = ry + rh;
    prect.ymax = prect.ymin + targetFullH;
    rrect.ymin = targetFullH;
    rrect.ymax = rrect.ymin + rh;

    GP<GPixmap> pm;
    GP<GBitmap> bm;
    constexpr double kGamma = 2.2;
    switch (mode) {
      case RENDER_MODE_COLOR:
        pm = img->get_pixmap(rrect, prect, kGamma, GPixel::WHITE);
        if (!pm) bm = img->get_bitmap(rrect, prect);
        break;
      case RENDER_MODE_BLACK:
        bm = img->get_bitmap(rrect, prect);
        if (!bm) pm = img->get_pixmap(rrect, prect, kGamma, GPixel::WHITE);
        break;
      case RENDER_MODE_MASKONLY:
        bm = img->get_bitmap(rrect, prect);
        break;
      case RENDER_MODE_BACKGROUND:
        pm = img->get_bg_pixmap(rrect, prect, kGamma, GPixel::WHITE);
        break;
      case RENDER_MODE_FOREGROUND:
        pm = img->get_fg_pixmap(rrect, prect, kGamma, GPixel::WHITE);
        if (!pm) bm = img->get_bitmap(rrect, prect);
        break;
      default:
        set_error("Unsupported DjVu render mode");
        return EVB_DJVU_ERR_INVALID;
    }

    if (pm) {
      return convert_pixmap_to_output(pm, pixelFormat);
    }
    if (bm) {
      return convert_bitmap_to_output(bm, pixelFormat);
    }

    // Layer is absent (e.g., MASKONLY on a photo page or BACKGROUND on a bitonal page).
    g_render_width = rw;
    g_render_height = rh;
    g_render_present = 0;
    return EVB_DJVU_OK;
  } catch (const GException &ex) {
    int32_t pending = check_pending_state(state);
    if (pending != EVB_DJVU_OK) {
      if (state->cache) state->cache->clear();
      pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
      return pending;
    }
    set_error(ex.get_cause() ? ex.get_cause() : "DjVu render failed");
    return EVB_DJVU_ERR_INVALID;
  } catch (const std::bad_alloc &) {
    set_error("Out of memory rendering DjVu page");
    return EVB_DJVU_ERR_OOM;
  } catch (const std::exception &ex) {
    set_error(ex.what());
    return EVB_DJVU_ERR_INTERNAL;
  }
}

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_get_outline(int32_t handle) {
  clear_call_state();
  auto *state = get_doc(handle);
  if (!state) return EVB_DJVU_ERR_INVALID;
  try {
    GP<DjVmNav> nav = state->doc->get_djvm_nav();
    if (!nav || nav->getBookMarkCount() <= 0) {
      set_output_string("[]");
      return EVB_DJVU_OK;
    }
    std::string json;
    json.reserve(1024);
    int pos = 0;
    int total = nav->getBookMarkCount();
    serialize_outline_range(nav, pos, total, total, 0, json);
    set_output_string(json);
    return EVB_DJVU_OK;
  } catch (const GException &ex) {
    set_error(ex.get_cause() ? ex.get_cause() : "Failed to read DjVu outline");
    return EVB_DJVU_ERR_INVALID;
  } catch (const std::bad_alloc &) {
    set_error("Out of memory reading DjVu outline");
    return EVB_DJVU_ERR_OOM;
  }
}

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_get_page_text(int32_t handle, int32_t pageIndex0, int32_t includeZones, int32_t maxZones) {
  clear_call_state();
  auto *state = get_doc(handle);
  if (!state) return EVB_DJVU_ERR_INVALID;
  PinnedComponentsGuard pinGuard(state);
  state->needComponent.clear();
  state->oomTriggered = false;
  state->limitExceeded = false;
  try {
    const int pages = state->doc->get_pages_num();
    if (pageIndex0 < 0 || pageIndex0 >= pages) {
      set_error("Page index out of bounds");
      return EVB_DJVU_ERR_BOUNDS;
    }
    GP<DjVuFile> file = get_page_file_raw(state, pageIndex0);
    int32_t pending = check_pending_state(state);
    if (pending != EVB_DJVU_OK) {
      pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
      return pending;
    }
    if (!file) {
      set_error("Failed to open DjVu page file");
      return EVB_DJVU_ERR_INVALID;
    }

    // Fast path: scan page IFF stream for TXTa/TXTz without decoding JB2/IW44 images.
    GP<DjVuTXT> txt = extract_text_from_pool_fast(file->get_init_data_pool());
    if (!txt) {
      GP<ByteStream> bs = file->get_text();
      if (bs) {
        GP<DjVuText> djvuText = DjVuText::create();
        djvuText->decode(bs);
        txt = djvuText->txt;
      }
    }
    if (!txt || txt->textUTF8.length() == 0) {
      set_output_string("{\"text\":\"\",\"pageWidth\":0,\"pageHeight\":0,\"zones\":[]}");
      return EVB_DJVU_OK;
    }

    const int pageW = txt->page_zone.rect.width();
    const int pageH = txt->page_zone.rect.height();
    std::string json;
    json.reserve(static_cast<size_t>(txt->textUTF8.length()) + 128);
    json += "{\"text\":";
    append_json_escaped(json, txt->textUTF8);
    char dims[96];
    std::snprintf(dims, sizeof(dims), ",\"pageWidth\":%d,\"pageHeight\":%d,\"zones\":[", pageW, pageH);
    json += dims;
    if (includeZones) {
      bool first = true;
      size_t count = 0;
      int32_t nextLineId = 0;
      size_t limit = maxZones > 0 ? static_cast<size_t>(maxZones) : 200000u;
      collect_leaf_zones(txt, txt->page_zone, -1, nextLineId, json, first, count, limit);
    }
    json += "]}";
    set_output_string(json);
    return EVB_DJVU_OK;
  } catch (const GException &ex) {
    int32_t pending = check_pending_state(state);
    if (pending != EVB_DJVU_OK) {
      pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
      return pending;
    }
    set_error(ex.get_cause() ? ex.get_cause() : "Failed to extract DjVu page text");
    return EVB_DJVU_ERR_INVALID;
  } catch (const std::bad_alloc &) {
    set_error("Out of memory extracting DjVu page text");
    return EVB_DJVU_ERR_OOM;
  } catch (const std::exception &ex) {
    set_error(ex.what());
    return EVB_DJVU_ERR_INTERNAL;
  }
}

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_page_has_text(int32_t handle, int32_t pageIndex0) {
  clear_call_state();
  auto *state = get_doc(handle);
  if (!state) return EVB_DJVU_ERR_INVALID;
  PinnedComponentsGuard pinGuard(state);
  state->needComponent.clear();
  state->oomTriggered = false;
  state->limitExceeded = false;
  try {
    const int pages = state->doc->get_pages_num();
    if (pageIndex0 < 0 || pageIndex0 >= pages) {
      return EVB_DJVU_ERR_BOUNDS;
    }
    GP<DjVuFile> file = get_page_file_raw(state, pageIndex0);
    int32_t pending = check_pending_state(state);
    if (pending != EVB_DJVU_OK) {
      pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
      return pending;
    }
    if (!file) return EVB_DJVU_ERR_INVALID;

    GP<DjVuTXT> txt = extract_text_from_pool_fast(file->get_init_data_pool());
    g_render_present = (txt && !is_whitespace_only(txt->textUTF8)) ? 1 : 0;
    return EVB_DJVU_OK;
  } catch (const GException &ex) {
    int32_t pending = check_pending_state(state);
    if (pending != EVB_DJVU_OK) {
      pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
      return pending;
    }
    set_error(ex.get_cause() ? ex.get_cause() : "Failed to probe DjVu page text");
    return EVB_DJVU_ERR_INVALID;
  } catch (const std::bad_alloc &) {
    set_error("Out of memory probing DjVu page text");
    return EVB_DJVU_ERR_OOM;
  } catch (const std::exception &ex) {
    set_error(ex.what());
    return EVB_DJVU_ERR_INTERNAL;
  }
}

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_get_metadata(int32_t handle) {
  clear_call_state();
  auto *state = get_doc(handle);
  if (!state) return EVB_DJVU_ERR_INVALID;
  PinnedComponentsGuard pinGuard(state);
  state->needComponent.clear();
  state->oomTriggered = false;
  state->limitExceeded = false;
  try {
    GMap<GUTF8String, GUTF8String> merged;
    auto mergeFromStream = [&](const GP<ByteStream> &bs) {
      if (!bs) return;
      GP<DjVuAnno> anno = DjVuAnno::create();
      anno->decode(bs);
      if (!anno || !anno->ant) return;
      for (GPosition pos = anno->ant->metadata; pos; ++pos) {
        GUTF8String key = anno->ant->metadata.key(pos);
        GUTF8String val = anno->ant->metadata[pos];
        merged[key] = val;
      }
    };

    // Document-level shared annotations (if any) + page 0 annotations.
    GP<DjVmDir> dir = safe_get_djvm_dir(state->doc);
    if (dir) {
      GP<DjVmDir::File> sharedAnno = dir->get_shared_anno_file();
      if (sharedAnno) {
        GP<DjVuFile> f = state->doc->get_djvu_file(sharedAnno->get_load_name());
        int32_t pending = check_pending_state(state);
        if (pending != EVB_DJVU_OK) {
          pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
          return pending;
        }
        if (f) {
          mergeFromStream(f->get_anno());
        }
      }
    }
    if (state->doc->get_pages_num() > 0) {
      GP<DjVuFile> page0 = get_page_file_raw(state, 0);
      int32_t pending = check_pending_state(state);
      if (pending != EVB_DJVU_OK) {
        pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
        return pending;
      }
      if (page0) {
        mergeFromStream(page0->get_merged_anno());
      }
    }

    std::string json = "{";
    bool first = true;
    for (GPosition pos = merged; pos; ++pos) {
      if (!first) json.push_back(',');
      first = false;
      append_json_escaped(json, merged.key(pos));
      json.push_back(':');
      append_json_escaped(json, merged[pos]);
    }
    json.push_back('}');
    set_output_string(json);
    return EVB_DJVU_OK;
  } catch (const GException &ex) {
    int32_t pending = check_pending_state(state);
    if (pending != EVB_DJVU_OK) {
      pinGuard.keepPinned = (pending == EVB_DJVU_NEED_COMPONENT);
      return pending;
    }
    set_error(ex.get_cause() ? ex.get_cause() : "Failed to read DjVu metadata");
    return EVB_DJVU_ERR_INVALID;
  }
}

EMSCRIPTEN_KEEPALIVE
const uint8_t *evb_djvu_output_ptr() {
  return g_output.empty() ? nullptr : g_output.data();
}

EMSCRIPTEN_KEEPALIVE
uint32_t evb_djvu_output_len() {
  return static_cast<uint32_t>(g_output.size());
}

EMSCRIPTEN_KEEPALIVE
void evb_djvu_release_output() {
  std::vector<uint8_t>().swap(g_output);
}

EMSCRIPTEN_KEEPALIVE
const char *evb_djvu_error_ptr() {
  return g_error.c_str();
}

EMSCRIPTEN_KEEPALIVE
uint32_t evb_djvu_error_len() {
  return static_cast<uint32_t>(g_error.size());
}

EMSCRIPTEN_KEEPALIVE
const char *evb_djvu_missing_component_ptr() {
  return g_missing_component.c_str();
}

EMSCRIPTEN_KEEPALIVE
uint32_t evb_djvu_missing_component_len() {
  return static_cast<uint32_t>(g_missing_component.size());
}

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_render_width() {
  return g_render_width;
}

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_render_height() {
  return g_render_height;
}

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_render_present() {
  return g_render_present;
}

}  // extern "C"
