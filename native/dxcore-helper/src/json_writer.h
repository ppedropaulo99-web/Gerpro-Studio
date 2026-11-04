// Serialização estrita da resposta do protocolo gerpro.dxcore-adapters v1.
// Independe do DXCore e do Win32 (testada com adaptadores sintéticos).

#pragma once

#include <cstddef>
#include <cstdint>

#include "adapters.h"

namespace gerpro {

// Limite da saída padrão, incluindo a quebra de linha final (igual a
// DXCORE_LIMITS.maxOutputBytes).
constexpr std::size_t kMaxOutputBytes = 65536;

// Maior texto decimal de um uint64 (18446744073709551615).
constexpr std::size_t kUint64Digits = 20;

// LUID canônico: 8 + ':' + 8 caracteres.
constexpr std::size_t kLuidChars = 17;

// Buffer de tamanho fixo. Escrever além do limite marca falha e não escreve
// nada além dele; uma resposta com falha nunca é enviada.
class JsonBuffer {
 public:
  JsonBuffer(std::size_t limit = kMaxOutputBytes);

  void Reset();
  void Put(char c);
  void Append(const char* text);
  void Append(const char* text, std::size_t length);

  bool Failed() const { return failed_; }
  std::size_t Size() const { return size_; }
  const char* Data() const { return data_; }

 private:
  char data_[kMaxOutputBytes];
  std::size_t limit_;
  std::size_t size_;
  bool failed_;
};

// uint64 em decimal, sem sinal nem zeros à esquerda. Devolve o tamanho.
std::size_t FormatUint64(std::uint64_t value, char (&out)[kUint64Digits]);

// uint32 em decimal (vendorId, deviceId). Devolve o tamanho.
std::size_t FormatUint32(std::uint32_t value, char (&out)[kUint64Digits]);

// LUID como HHHHHHHH:LLLLLLLL, hexadecimal maiúsculo.
void FormatLuid(std::uint32_t high, std::uint32_t low, char (&out)[kLuidChars]);

// Resposta completa, com uma quebra de linha final. `false` se houver mais de
// kMaxAdapters adaptadores, se algum registro violar o protocolo (descrição
// vazia, longa demais ou com substituto isolado) ou se o limite estourar:
// nesse caso o buffer não deve ser escrito.
bool SerializeResponse(const AdapterRecord* adapters, std::size_t count, JsonBuffer& out);

}  // namespace gerpro
