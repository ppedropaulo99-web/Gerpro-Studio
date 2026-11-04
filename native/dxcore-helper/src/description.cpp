// DriverDescription: UTF-8 estrito -> UTF-16 sanitizado (ver description.h).

#include "description.h"

namespace gerpro {

namespace {

constexpr char16_t kSpace = 0x0020;

// Decodifica uma sequência UTF-8 a partir de bytes[i]. Recusa sequências
// longas demais, substitutos codificados, valores acima de U+10FFFF e
// sequências truncadas ou com byte de continuação inválido.
bool DecodeUtf8(const std::uint8_t* bytes, std::size_t length, std::size_t& i, std::uint32_t& codePoint) {
  const std::uint8_t lead = bytes[i];
  std::size_t continuation = 0;
  std::uint32_t value = 0;
  if (lead < 0x80) {
    value = lead;
  } else if (lead >= 0xC2 && lead <= 0xDF) {
    value = lead & 0x1Fu;
    continuation = 1;
  } else if (lead >= 0xE0 && lead <= 0xEF) {
    value = lead & 0x0Fu;
    continuation = 2;
  } else if (lead >= 0xF0 && lead <= 0xF4) {
    value = lead & 0x07u;
    continuation = 3;
  } else {
    return false;
  }
  if (continuation > length - i - 1) return false;
  for (std::size_t k = 1; k <= continuation; ++k) {
    const std::uint8_t next = bytes[i + k];
    if ((next & 0xC0u) != 0x80u) return false;
    value = (value << 6) | (next & 0x3Fu);
  }
  if (continuation == 2 && (value < 0x800u || (value >= 0xD800u && value <= 0xDFFFu))) return false;
  if (continuation == 3 && (value < 0x10000u || value > 0x10FFFFu)) return false;
  i += continuation + 1;
  codePoint = value;
  return true;
}

}  // namespace

bool IsStrippedUnit(char16_t unit) {
  const std::uint32_t u = unit;
  return u <= 0x001Fu || (u >= 0x007Fu && u <= 0x009Fu) || (u >= 0x200Bu && u <= 0x200Fu) || (u >= 0x202Au && u <= 0x202Eu) ||
         (u >= 0x2060u && u <= 0x2069u) || u == 0xFEFFu;
}

bool SanitizeDescription(const std::uint8_t* bytes, std::size_t length, char16_t* out, std::size_t capacity, std::size_t& outLength) {
  outLength = 0;
  if (bytes == nullptr || out == nullptr || capacity == 0) return false;

  std::size_t end = 0;
  while (end < length && bytes[end] != 0) ++end;
  if (end == length) return false;  // sem NUL dentro do tamanho informado

  bool pendingSpace = false;
  bool full = false;
  std::size_t i = 0;
  // O texto inteiro é validado, mesmo depois de cheio: UTF-8 inválido em
  // qualquer ponto descarta a descrição.
  while (i < end) {
    std::uint32_t codePoint = 0;
    if (!DecodeUtf8(bytes, end, i, codePoint)) {
      outLength = 0;
      return false;
    }
    if (full) continue;

    char16_t units[2];
    std::size_t count = 1;
    if (codePoint >= 0x10000u) {
      const std::uint32_t v = codePoint - 0x10000u;
      units[0] = static_cast<char16_t>(0xD800u + (v >> 10));
      units[1] = static_cast<char16_t>(0xDC00u + (v & 0x3FFu));
      count = 2;
    } else {
      units[0] = static_cast<char16_t>(codePoint);
      if (units[0] == kSpace || IsStrippedUnit(units[0])) {
        // Espaço no início é descartado; os demais esperam o próximo caractere.
        if (outLength > 0) pendingSpace = true;
        continue;
      }
    }

    const std::size_t needed = count + (pendingSpace ? 1 : 0);
    if (needed > capacity - outLength) {
      // Corta aqui: nunca separa um par substituto, nunca termina em espaço.
      full = true;
      continue;
    }
    if (pendingSpace) out[outLength++] = kSpace;
    pendingSpace = false;
    for (std::size_t k = 0; k < count; ++k) out[outLength++] = units[k];
  }
  return outLength > 0;
}

}  // namespace gerpro
