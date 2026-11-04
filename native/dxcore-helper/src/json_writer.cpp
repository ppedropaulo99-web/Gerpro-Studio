// Serialização estrita da resposta do protocolo gerpro.dxcore-adapters v1
// (ver json_writer.h).
//
// Formato fixo: chaves na ordem de DXCORE_WIRE_ADAPTER_KEYS, sem espaços,
// uma quebra de linha final, só ASCII. Nada de printf/locale: números e LUID
// são formatados à mão.

#include "json_writer.h"

namespace gerpro {

namespace {

constexpr char kHexDigits[] = "0123456789ABCDEF";

// Valores fixos do protocolo (iguais a DXCORE_PROTOCOL e DXCORE_PROTOCOL_VERSION).
constexpr char kResponseStart[] = "{\"protocol\":\"gerpro.dxcore-adapters\",\"version\":1,\"adapters\":[";
constexpr char kResponseEnd[] = "]}\n";

void AppendKey(JsonBuffer& out, const char* key, bool first) {
  if (!first) out.Put(',');
  out.Put('"');
  out.Append(key);
  out.Put('"');
  out.Put(':');
}

void AppendNull(JsonBuffer& out) { out.Append("null", 4); }

void AppendBool(JsonBuffer& out, const OptionalBool& value) {
  if (!value.present) return AppendNull(out);
  if (value.value) {
    out.Append("true", 4);
  } else {
    out.Append("false", 5);
  }
}

// Inteiro de 64 bits sempre como texto decimal entre aspas (nunca número JSON).
void AppendUint64String(JsonBuffer& out, const OptionalUint64& value) {
  if (!value.present) return AppendNull(out);
  char digits[kUint64Digits];
  const std::size_t length = FormatUint64(value.value, digits);
  out.Put('"');
  out.Append(digits, length);
  out.Put('"');
}

void AppendHardwareId(JsonBuffer& out, bool present, std::uint32_t value) {
  if (!present) return AppendNull(out);
  char digits[kUint64Digits];
  out.Append(digits, FormatUint32(value, digits));
}

void AppendLuid(JsonBuffer& out, const AdapterRecord& adapter) {
  if (!adapter.hasLuid) return AppendNull(out);
  char text[kLuidChars];
  FormatLuid(adapter.luidHigh, adapter.luidLow, text);
  out.Put('"');
  out.Append(text, kLuidChars);
  out.Put('"');
}

// Escape de 6 caracteres: barra invertida, 'u' e 4 dígitos hexadecimais.
void AppendUnicodeEscape(JsonBuffer& out, char16_t unit) {
  const std::uint32_t v = unit;
  out.Put('\\');
  out.Put('u');
  out.Put(kHexDigits[(v >> 12) & 0xFu]);
  out.Put(kHexDigits[(v >> 8) & 0xFu]);
  out.Put(kHexDigits[(v >> 4) & 0xFu]);
  out.Put(kHexDigits[v & 0xFu]);
}

bool IsHighSurrogate(char16_t unit) {
  const std::uint32_t u = unit;
  return u >= 0xD800u && u <= 0xDBFFu;
}
bool IsLowSurrogate(char16_t unit) {
  const std::uint32_t u = unit;
  return u >= 0xDC00u && u <= 0xDFFFu;
}

// ASCII imprimível passa direto (aspas e barra invertida escapadas); todo o
// resto vira escape. Pares substitutos viram dois escapes; substituto
// isolado é violação do protocolo.
bool AppendDescription(JsonBuffer& out, const AdapterRecord& adapter) {
  if (!adapter.hasDescription) {
    AppendNull(out);
    return true;
  }
  const std::size_t length = adapter.descriptionLength;
  if (length == 0 || length > kMaxDescriptionUnits) return false;
  out.Put('"');
  for (std::size_t i = 0; i < length; ++i) {
    const char16_t unit = adapter.description[i];
    if (IsHighSurrogate(unit)) {
      if (i + 1 >= length || !IsLowSurrogate(adapter.description[i + 1])) return false;
      AppendUnicodeEscape(out, unit);
      AppendUnicodeEscape(out, adapter.description[i + 1]);
      ++i;
    } else if (IsLowSurrogate(unit)) {
      return false;
    } else if (unit == u'"') {
      out.Put('\\');
      out.Put('"');
    } else if (unit == u'\\') {
      out.Put('\\');
      out.Put('\\');
    } else if (static_cast<std::uint32_t>(unit) >= 0x20u && static_cast<std::uint32_t>(unit) <= 0x7Eu) {
      out.Put(static_cast<char>(unit));
    } else {
      AppendUnicodeEscape(out, unit);
    }
  }
  out.Put('"');
  return true;
}

bool AppendAdapter(JsonBuffer& out, const AdapterRecord& adapter) {
  out.Put('{');
  AppendKey(out, "luid", true);
  AppendLuid(out, adapter);
  AppendKey(out, "vendorId", false);
  AppendHardwareId(out, adapter.hasHardwareId, adapter.vendorId);
  AppendKey(out, "deviceId", false);
  AppendHardwareId(out, adapter.hasHardwareId, adapter.deviceId);
  AppendKey(out, "description", false);
  if (!AppendDescription(out, adapter)) return false;
  AppendKey(out, "isHardware", false);
  AppendBool(out, adapter.isHardware);
  AppendKey(out, "isIntegrated", false);
  AppendBool(out, adapter.isIntegrated);
  AppendKey(out, "dedicatedAdapterMemory", false);
  AppendUint64String(out, adapter.dedicatedAdapterMemory);
  AppendKey(out, "dedicatedSystemMemory", false);
  AppendUint64String(out, adapter.dedicatedSystemMemory);
  AppendKey(out, "sharedSystemMemory", false);
  AppendUint64String(out, adapter.sharedSystemMemory);
  out.Put('}');
  return true;
}

}  // namespace

JsonBuffer::JsonBuffer(std::size_t limit) : limit_(limit > kMaxOutputBytes ? kMaxOutputBytes : limit), size_(0), failed_(false) {}

void JsonBuffer::Reset() {
  size_ = 0;
  failed_ = false;
}

void JsonBuffer::Put(char c) {
  if (failed_) return;
  if (size_ >= limit_) {
    failed_ = true;
    return;
  }
  data_[size_++] = c;
}

void JsonBuffer::Append(const char* text) {
  if (text == nullptr) return;
  while (*text != '\0') Put(*text++);
}

void JsonBuffer::Append(const char* text, std::size_t length) {
  for (std::size_t i = 0; i < length; ++i) Put(text[i]);
}

std::size_t FormatUint64(std::uint64_t value, char (&out)[kUint64Digits]) {
  char reversed[kUint64Digits];
  std::size_t length = 0;
  do {
    reversed[length++] = static_cast<char>('0' + static_cast<int>(value % 10u));
    value /= 10u;
  } while (value != 0u);
  for (std::size_t i = 0; i < length; ++i) out[i] = reversed[length - 1 - i];
  return length;
}

std::size_t FormatUint32(std::uint32_t value, char (&out)[kUint64Digits]) { return FormatUint64(value, out); }

void FormatLuid(std::uint32_t high, std::uint32_t low, char (&out)[kLuidChars]) {
  for (int i = 0; i < 8; ++i) {
    out[i] = kHexDigits[(high >> (28 - 4 * i)) & 0xFu];
    out[9 + i] = kHexDigits[(low >> (28 - 4 * i)) & 0xFu];
  }
  out[8] = ':';
}

bool SerializeResponse(const AdapterRecord* adapters, std::size_t count, JsonBuffer& out) {
  out.Reset();
  if (count > kMaxAdapters || (count > 0 && adapters == nullptr)) return false;
  out.Append(kResponseStart);
  for (std::size_t i = 0; i < count; ++i) {
    if (i > 0) out.Put(',');
    if (!AppendAdapter(out, adapters[i])) return false;
  }
  out.Append(kResponseEnd);
  return !out.Failed();
}

}  // namespace gerpro
