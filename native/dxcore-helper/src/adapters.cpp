// Enumeração dos adaptadores D3D11_GRAPHICS pelo DXCore e leitura das
// propriedades do protocolo v1.
//
// Só leitura: nenhum dispositivo gráfico é criado, nenhum estado é alterado.
// Cada propriedade é lida só se IsPropertySupported confirmar e se o tamanho
// informado pelo DXCore for exatamente o do tipo esperado; senão o campo fica
// ausente (null). Falha de um adaptador inteiro (GetAdapter, IsValid) ou da
// lista é global: nada parcial é devolvido.

#include "adapters.h"

// Define DXCORE_ADAPTER_ATTRIBUTE_D3D11_GRAPHICS (DEFINE_GUID) nesta unidade:
// <initguid.h> depois de <windows.h> (incluído por adapters.h) e antes de
// <dxcore.h>. Este é o único arquivo que inclui <dxcore.h> com <initguid.h>.
#include <initguid.h>

#include <dxcore.h>
#include <wrl/client.h>

#include "description.h"

namespace gerpro {

namespace {

using Microsoft::WRL::ComPtr;

static_assert(sizeof(bool) == 1, "IsHardware/IsIntegrated: bool de 1 byte");
static_assert(sizeof(LUID) == 8, "InstanceLuid: LUID de 8 bytes");
static_assert(sizeof(DXCoreHardwareID) == 16, "HardwareID: 4 campos de 32 bits");
static_assert(sizeof(std::uint64_t) == 8, "memorias: 64 bits");

// Lê uma propriedade de tamanho fixo. `false`: não suportada, tamanho
// diferente do tipo ou falha na leitura.
template <typename T>
bool ReadFixed(IDXCoreAdapter* adapter, DXCoreAdapterProperty property, T& value) {
  if (!adapter->IsPropertySupported(property)) return false;
  size_t size = 0;
  if (FAILED(adapter->GetPropertySize(property, &size)) || size != sizeof(T)) return false;
  T temporary{};
  if (FAILED(adapter->GetProperty(property, sizeof(T), &temporary))) return false;
  value = temporary;
  return true;
}

// Booleano lido como byte bruto: só 0 e 1 são aceitos.
OptionalBool ReadBool(IDXCoreAdapter* adapter, DXCoreAdapterProperty property) {
  std::uint8_t raw = 0;
  if (!ReadFixed(adapter, property, raw) || raw > 1u) return OptionalBool{false, false};
  return OptionalBool{true, raw == 1u};
}

OptionalUint64 ReadMemory(IDXCoreAdapter* adapter, DXCoreAdapterProperty property) {
  std::uint64_t value = 0;
  if (!ReadFixed(adapter, property, value)) return OptionalUint64{false, 0};
  return OptionalUint64{true, value};
}

// DriverDescription: texto terminado em NUL, de tamanho variável. Acima de
// kMaxDescriptionBytes nem é lido. Codificação não documentada: só UTF-8
// válido é aceito (description.cpp).
void ReadDescription(IDXCoreAdapter* adapter, AdapterRecord& record) {
  if (!adapter->IsPropertySupported(DXCoreAdapterProperty::DriverDescription)) return;
  size_t size = 0;
  if (FAILED(adapter->GetPropertySize(DXCoreAdapterProperty::DriverDescription, &size))) return;
  if (size == 0 || size > kMaxDescriptionBytes) return;
  std::uint8_t buffer[kMaxDescriptionBytes] = {};
  if (FAILED(adapter->GetProperty(DXCoreAdapterProperty::DriverDescription, size, buffer))) return;
  std::size_t length = 0;
  if (!SanitizeDescription(buffer, size, record.description, kMaxDescriptionUnits, length)) return;
  record.hasDescription = true;
  record.descriptionLength = length;
}

void ReadAdapter(IDXCoreAdapter* adapter, AdapterRecord& record) {
  ClearRecord(record);

  LUID luid = {};
  if (ReadFixed(adapter, DXCoreAdapterProperty::InstanceLuid, luid)) {
    record.hasLuid = true;
    // HighPart é LONG (com sinal): reinterpretado como 32 bits sem sinal.
    record.luidHigh = static_cast<std::uint32_t>(luid.HighPart);
    record.luidLow = static_cast<std::uint32_t>(luid.LowPart);
  }

  DXCoreHardwareID hardwareId = {};
  if (ReadFixed(adapter, DXCoreAdapterProperty::HardwareID, hardwareId)) {
    // Só fabricante e dispositivo; subSysID e revision não são copiados.
    record.hasHardwareId = true;
    record.vendorId = hardwareId.vendorID;
    record.deviceId = hardwareId.deviceID;
  }
  hardwareId = DXCoreHardwareID{};

  ReadDescription(adapter, record);

  record.isHardware = ReadBool(adapter, DXCoreAdapterProperty::IsHardware);
  record.isIntegrated = ReadBool(adapter, DXCoreAdapterProperty::IsIntegrated);
  record.dedicatedAdapterMemory = ReadMemory(adapter, DXCoreAdapterProperty::DedicatedAdapterMemory);
  record.dedicatedSystemMemory = ReadMemory(adapter, DXCoreAdapterProperty::DedicatedSystemMemory);
  record.sharedSystemMemory = ReadMemory(adapter, DXCoreAdapterProperty::SharedSystemMemory);
}

}  // namespace

EnumerationStatus EnumerateAdapters(const DxcoreLibrary& library, AdapterSet& out) {
  out.count = 0;
  if (library.createAdapterFactory == nullptr) return EnumerationStatus::FactoryFailed;

  ComPtr<IDXCoreAdapterFactory> factory;
  if (FAILED(library.createAdapterFactory(IID_PPV_ARGS(&factory))) || !factory) return EnumerationStatus::FactoryFailed;

  const GUID attributes[] = {DXCORE_ADAPTER_ATTRIBUTE_D3D11_GRAPHICS};
  ComPtr<IDXCoreAdapterList> list;
  if (FAILED(factory->CreateAdapterList(1, attributes, IID_PPV_ARGS(&list))) || !list) return EnumerationStatus::EnumerationFailed;

  const std::uint32_t count = list->GetAdapterCount();
  // Acima do limite: nada parcial (o protocolo recusaria a lista inteira).
  if (count > kMaxAdapters) return EnumerationStatus::EnumerationFailed;

  for (std::uint32_t i = 0; i < count; ++i) {
    ComPtr<IDXCoreAdapter> adapter;
    if (FAILED(list->GetAdapter(i, IID_PPV_ARGS(&adapter))) || !adapter || !adapter->IsValid()) {
      out.count = 0;
      return EnumerationStatus::EnumerationFailed;
    }
    ReadAdapter(adapter.Get(), out.items[i]);
  }

  // A lista mudou durante a leitura (adaptador adicionado ou removido).
  if (list->IsStale()) {
    out.count = 0;
    return EnumerationStatus::EnumerationFailed;
  }
  out.count = count;
  return EnumerationStatus::Ok;
}

}  // namespace gerpro
