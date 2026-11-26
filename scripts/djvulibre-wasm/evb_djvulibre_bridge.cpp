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
constexpr size_t MAX_PROVIDED_COMPONENT_CACHE_BYTES = 32u * 1024u * 1024u;
constexpr uint64_t MAX_RENDER_BUFFER_BYTES = 512ull * 1024ull * 1024ull;

// Synchronous host component reader hook.
// JS attaches `Module.evbReadComponentSync(docId, name)` when synchronous reads
// are available (Node fs.readSync / Worker FileReaderSync).
// Return values:
//   1: component written into wasm heap, *outPtr and *outLen populated
//   0: async host needs to fetch component first (caller will return NEED_COMPONENT)
//  -1: component unavailable / error
EM_JS(int32_t, evb_js_read_component,
      (int32_t docId, const char *namePtr, int32_t nameLen, uint32_t *outPtr, uint32_t *outLen), {
  const reader = Module['evbReadComponentSync'];
  if (typeof reader !== 'function') {
    return 0;
  }
  const name = UTF8ToString(namePtr, nameLen);
  const bytes = reader(docId, name);
  if (bytes === null || bytes === undefined) {
    return 0;
  }
  if (bytes === false) {
    return -1;
  }
  const len = bytes.byteLength >>> 0;
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

bool parse_jpeg_dimensions(const uint8_t *data, size_t len, int &width, int &height) {
  if (len < 4 || data[0] != 0xFF || data[1] != 0xD8) {
    return false;
  }
  size_t pos = 2;
  while (pos + 4 <= len) {
    if (data[pos] != 0xFF) {
      ++pos;
      continue;
    }
    while (pos < len && data[pos] == 0xFF) {
      ++pos;
    }
    if (pos >= len) {
      break;
    }
    uint8_t marker = data[pos++];
    if (marker == 0xD9 || marker == 0xDA) {
      break;
    }
    if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      continue;
    }
    if (pos + 2 > len) {
      break;
    }
    uint16_t segLen = read_be16(data + pos);
    if (segLen < 2 || pos + segLen > len) {
      break;
    }
    bool isSof = (marker >= 0xC0 && marker <= 0xC3)
              || (marker >= 0xC5 && marker <= 0xC7)
              || (marker >= 0xC9 && marker <= 0xCB)
              || (marker >= 0xCD && marker <= 0xCF);
    if (isSof && segLen >= 7) {
      height = read_be16(data + pos + 3);
      width = read_be16(data + pos + 5);
      return width > 0 && height > 0;
    }
    pos += segLen;
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

void evict_non_dict_components(EvbDjVuDocumentState *state) {
  if (state->providedBytes <= MAX_PROVIDED_COMPONENT_CACHE_BYTES) {
    return;
  }
  GP<DjVmDir> dir = safe_get_djvm_dir(state->doc);
  size_t idx = 0;
  while (idx < state->providedOrder.size()
         && state->providedBytes > MAX_PROVIDED_COMPONENT_CACHE_BYTES) {
    const std::string &name = state->providedOrder[idx];
    if (state->pinnedComponents.count(name) > 0) {
      ++idx;
      continue;
    }
    bool isInclude = false;
    if (dir) {
      GP<DjVmDir::File> f = dir->name_to_file(GUTF8String(name.c_str()));
      if (!f) {
        f = dir->id_to_file(GUTF8String(name.c_str()));
      }
      if (f && f->is_include()) {
        isInclude = true;
      }
    }
    if (isInclude) {
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

struct PinnedComponentsGuard {
  EvbDjVuDocumentState *state;
  bool keepPinned = false;
  explicit PinnedComponentsGuard(EvbDjVuDocumentState *s) : state(s) {}
  ~PinnedComponentsGuard() {
    if (state && !keepPinned && !state->pinnedComponents.empty()) {
      state->pinnedComponents.clear();
      evict_non_dict_components(state);
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
    size_t maxZones) {
  if (zoneCount >= maxZones) {
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
    collect_leaf_zones(txt, zone.children[pos], lineId, nextLineId, out, first, zoneCount, maxZones);
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
  if (chkid != "FORM:DJVU") {
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

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t evb_djvu_open(int32_t docId, const uint8_t *initPtr, int32_t initLen, uint32_t cacheBytes) {
  clear_call_state();
  if (!initPtr || initLen <= 0) {
    set_error("Empty DjVu input");
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
  try {
    std::string name(namePtr, static_cast<size_t>(nameLen));
    auto existing = state->providedComponents.find(name);
    if (existing != state->providedComponents.end()) {
      state->providedBytes -= existing->second.size();
      existing->second.assign(dataPtr, dataPtr + dataLen);
      state->providedBytes += existing->second.size();
      auto orderIt = std::find(state->providedOrder.begin(), state->providedOrder.end(), name);
      if (orderIt != state->providedOrder.end()) {
        state->providedOrder.erase(orderIt);
      }
      state->providedOrder.push_back(name);
    } else {
      std::vector<uint8_t> buf(dataPtr, dataPtr + dataLen);
      state->providedBytes += buf.size();
      state->providedComponents.emplace(name, std::move(buf));
      state->providedOrder.push_back(name);
    }
    state->pinnedComponents.insert(name);
    evict_non_dict_components(state);
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
    // Fast INFO parse from raw IFF stream without decoding JB2/IW44 bitmaps.
    GP<DataPool> pool = file->get_init_data_pool();
    if (!pool) {
      set_error("DjVu page has no data");
      return EVB_DJVU_ERR_INVALID;
    }
    GP<ByteStream> bs = pool->get_stream();
    GP<IFFByteStream> iff = IFFByteStream::create(bs);
    GUTF8String chkid;
    if (!iff->get_chunk(chkid) || chkid != "FORM:DJVU") {
      set_error("DjVu page is not a FORM:DJVU stream");
      return EVB_DJVU_ERR_INVALID;
    }
    GP<DjVuInfo> info;
    bool hasMask = false;
    bool hasBg = false;
    bool hasFg = false;
    while (iff->get_chunk(chkid)) {
      if (chkid == "INFO") {
        info = DjVuInfo::create();
        info->decode(*iff->get_bytestream());
      } else if (chkid == "Sjbz" || chkid == "Smmr") {
        hasMask = true;
      } else if (chkid == "BG44" || chkid == "BGjp" || chkid == "BG2k" || chkid == "PM44" || chkid == "BM44") {
        hasBg = true;
      } else if (chkid == "FG44" || chkid == "FGbz" || chkid == "FGjp" || chkid == "FG2k") {
        hasFg = true;
      }
      iff->close_chunk();
    }
    if (!info || info->width <= 0 || info->height <= 0) {
      set_error("DjVu page is missing a valid INFO chunk");
      return EVB_DJVU_ERR_INVALID;
    }
    int rotation = orientation_to_degrees(info->orientation);
    int width = (rotation == 90 || rotation == 270) ? info->height : info->width;
    int height = (rotation == 90 || rotation == 270) ? info->width : info->height;
    int dpi = (info->dpi >= 25 && info->dpi <= 6000) ? info->dpi : 300;
    const char *pageType = "unknown";
    if (hasMask && (hasBg || hasFg)) {
      pageType = "compound";
    } else if (hasMask) {
      pageType = "bitonal";
    } else if (hasBg) {
      pageType = "photo";
    }
    char json[256];
    std::snprintf(
        json,
        sizeof(json),
        "{\"width\":%d,\"height\":%d,\"rawWidth\":%d,\"rawHeight\":%d,\"dpi\":%d,\"rotation\":%d,\"pageType\":\"%s\"}",
        width,
        height,
        info->width,
        info->height,
        dpi,
        rotation,
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
    uint64_t pageBytes = static_cast<uint64_t>(std::max(0, pool->get_size()));
    GP<ByteStream> bs = pool->get_stream();
    GP<IFFByteStream> iff = IFFByteStream::create(bs);
    GUTF8String chkid;
    int formSize = iff->get_chunk(chkid);
    if (formSize <= 0 || chkid != "FORM:DJVU") {
      set_error("DjVu page is not a FORM:DJVU stream");
      return EVB_DJVU_ERR_INVALID;
    }

    GP<DjVuInfo> info;
    bool hasMask = false;
    uint64_t maskBytes = 0;
    ChunkLayerInfo bg;
    ChunkLayerInfo fg;

    int chunkSize = 0;
    while ((chunkSize = iff->get_chunk(chkid)) > 0) {
      const std::string id(static_cast<const char *>(chkid));
      if (id == "INFO") {
        info = DjVuInfo::create();
        info->decode(*iff->get_bytestream());
      } else if (id == "Sjbz") {
        hasMask = true;
        maskBytes += static_cast<uint64_t>(chunkSize);
      } else if (id == "BG44" || id == "BGjp" || id == "BG2k" || id == "PM44") {
        bg.present = true;
        if (bg.kind.empty()) bg.kind = id;
        bg.bytes += static_cast<uint64_t>(chunkSize);
        if ((id == "BG44" || id == "PM44") && bg.width == 0 && chunkSize >= 8) {
          uint8_t hdr[8];
          if (iff->get_bytestream()->readall(hdr, 8) == 8 && hdr[0] == 0) {
            bg.width = read_be16(hdr + 4);
            bg.height = read_be16(hdr + 6);
          }
        } else if (id == "BGjp" && bg.width == 0 && chunkSize <= 16 * 1024 * 1024) {
          std::vector<uint8_t> jpeg(static_cast<size_t>(chunkSize));
          if (iff->get_bytestream()->readall(jpeg.data(), chunkSize) == chunkSize) {
            parse_jpeg_dimensions(jpeg.data(), jpeg.size(), bg.width, bg.height);
          }
        }
      } else if (id == "FG44" || id == "FGbz" || id == "FGjp" || id == "FG2k") {
        fg.present = true;
        if (fg.kind.empty()) fg.kind = id;
        fg.bytes += static_cast<uint64_t>(chunkSize);
        if (id == "FG44" && fg.width == 0 && chunkSize >= 8) {
          uint8_t hdr[8];
          if (iff->get_bytestream()->readall(hdr, 8) == 8 && hdr[0] == 0) {
            fg.width = read_be16(hdr + 4);
            fg.height = read_be16(hdr + 6);
          }
        } else if (id == "FGjp" && fg.width == 0 && chunkSize <= 16 * 1024 * 1024) {
          std::vector<uint8_t> jpeg(static_cast<size_t>(chunkSize));
          if (iff->get_bytestream()->readall(jpeg.data(), chunkSize) == chunkSize) {
            parse_jpeg_dimensions(jpeg.data(), jpeg.size(), fg.width, fg.height);
          }
        }
      }
      iff->close_chunk();
    }

    int rotation = info ? orientation_to_degrees(info->orientation) : 0;
    int uprightW = info ? ((rotation == 90 || rotation == 270) ? info->height : info->width) : 0;
    int uprightH = info ? ((rotation == 90 || rotation == 270) ? info->width : info->height) : 0;
    int dpi = (info && info->dpi >= 25 && info->dpi <= 6000) ? info->dpi : 300;

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
        static_cast<unsigned long long>(pageBytes),
        rotation);
    json += head;
    if (info && uprightW > 0 && uprightH > 0) {
      char ibuf[128];
      std::snprintf(
          ibuf,
          sizeof(ibuf),
          "\"info\":{\"width\":%d,\"height\":%d,\"dpi\":%d},",
          uprightW,
          uprightH,
          dpi);
      json += ibuf;
    } else {
      json += "\"info\":null,";
    }
    char mbuf[96];
    if (hasMask) {
      std::snprintf(
          mbuf,
          sizeof(mbuf),
          "\"hasMask\":true,\"maskBytes\":%llu,",
          static_cast<unsigned long long>(maskBytes));
    } else {
      std::snprintf(mbuf, sizeof(mbuf), "\"hasMask\":false,\"maskBytes\":null,");
    }
    json += mbuf;
    json += "\"background\":";
    appendLayer(json, bg);
    json += ",\"foreground\":";
    appendLayer(json, fg);
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
  try {
    const int pages = state->doc->get_pages_num();
    if (pageIndex0 < 0 || pageIndex0 >= pages) {
      set_error("Page index out of bounds");
      return EVB_DJVU_ERR_BOUNDS;
    }

    GP<DjVuImage> img = decode_page_image(state, pageIndex0);
    int32_t pending = check_pending_state(state);
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
    if (nativeW <= 0 || nativeH <= 0) {
      set_error("DjVu page has invalid dimensions");
      return EVB_DJVU_ERR_INVALID;
    }

    int targetFullW = fullW > 0 ? fullW : nativeW;
    int targetFullH = fullH > 0 ? fullH : nativeH;
    int rx = rectX >= 0 ? rectX : 0;
    int ry = rectY >= 0 ? rectY : 0;
    int rw = rectW > 0 ? rectW : targetFullW;
    int rh = rectH > 0 ? rectH : targetFullH;

    if (rx + rw > targetFullW || ry + rh > targetFullH || rw <= 0 || rh <= 0) {
      set_error("Render rectangle out of bounds");
      return EVB_DJVU_ERR_BOUNDS;
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
