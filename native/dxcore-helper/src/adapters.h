// Registro de adaptador do protocolo gerpro.dxcore-adapters v1 e enumeração
// pelo DXCore.
//
// Este header não inclui o DXCore: os tipos abaixo são só os campos do
// protocolo, usados também pelos testes sintéticos do serializador. Somente
// adapters.cpp inclui <dxcore.h>.

#pragma once

#include <cstddef>
#include <cstdint>

#include "dxcore_loader.h"

namespace gerpro {

// Limites do protocolo (iguais a DXCORE_LIMITS em dxcore-contract.ts).
constexpr std::size_t kMaxAdapters = 16;
constexpr std::size_t kMaxDescriptionUnits = 128;

struct OptionalBool {
  bool present;
  bool value;
};

struct OptionalUint64 {
  bool present;
  std::uint64_t value;
};

// Um adaptador, já reduzido aos campos do protocolo. Campo ausente
// (`present == false`) vira `null` no JSON; nada é inventado.
struct AdapterRecord {
  // InstanceLuid: parte alta (LONG reinterpretado como 32 bits sem sinal) e baixa.
  bool hasLuid;
  std::uint32_t luidHigh;
  std::uint32_t luidLow;

  // HardwareID: só vendorID e deviceID. subSysID e revision nunca são copiados.
  bool hasHardwareId;
  std::uint32_t vendorId;
  std::uint32_t deviceId;

  // DriverDescription já decodificada e sanitizada (description.h), em UTF-16.
  bool hasDescription;
  char16_t description[kMaxDescriptionUnits];
  std::size_t descriptionLength;

  OptionalBool isHardware;
  OptionalBool isIntegrated;

  OptionalUint64 dedicatedAdapterMemory;
  OptionalUint64 dedicatedSystemMemory;
  OptionalUint64 sharedSystemMemory;
};

struct AdapterSet {
  AdapterRecord items[kMaxAdapters];
  std::size_t count;
};

enum class EnumerationStatus {
  Ok,
  // DXCoreCreateAdapterFactory falhou (código de saída 11).
  FactoryFailed,
  // Lista, contagem, adaptador inválido, lista alterada durante a leitura ou
  // mais de kMaxAdapters adaptadores (código de saída 12).
  EnumerationFailed
};

// Zera um registro: todos os campos ausentes. Inline: os testes do
// serializador usam sem ligar adapters.cpp (que depende do DXCore).
inline void ClearRecord(AdapterRecord& record) { record = AdapterRecord{}; }

// Lê os adaptadores com o atributo D3D11_GRAPHICS. Não cria dispositivos.
// Em qualquer falha global, `out.count` volta a 0 (nada parcial é usado).
EnumerationStatus EnumerateAdapters(const DxcoreLibrary& library, AdapterSet& out);

}  // namespace gerpro
