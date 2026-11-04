// gerpro-dxcore-helper.exe: lista os adaptadores gráficos pelo DXCore e
// responde no protocolo gerpro.dxcore-adapters v1 (docs/04-hardware-advisor.md).
//
// Linha de comando única: `--protocol 1`. Sem shell, sem processos filhos,
// sem rede, sem arquivos, sem Registro, sem elevação, sem log. A saída de
// erro nunca é usada; a saída padrão só recebe a resposta completa, e só com
// código 0.

#include <cwchar>

#include "adapters.h"
#include "dxcore_loader.h"
#include "json_writer.h"

namespace {

// Códigos de saída (iguais a DXCORE_EXIT_CODES em dxcore-contract.ts).
constexpr int kExitOk = 0;
// dxcore.dll ausente ou sem DXCoreCreateAdapterFactory; também quando as
// proteções de carregamento não puderam ser estabelecidas (nada é carregado).
constexpr int kExitDxcoreUnavailable = 10;
constexpr int kExitFactoryFailed = 11;
constexpr int kExitEnumerationFailed = 12;
// Saída padrão indisponível, não é pipe, resposta fora do limite ou falha ao escrever.
constexpr int kExitOutputFailed = 13;
constexpr int kExitUsage = 64;

// Argumentos fixos (iguais a DXCORE_HELPER_ARGS).
constexpr wchar_t kProtocolFlag[] = L"--protocol";
constexpr wchar_t kProtocolVersion[] = L"1";

bool ArgumentsAreExact(int argc, wchar_t** argv) {
  return argc == 3 && argv != nullptr && argv[1] != nullptr && argv[2] != nullptr && std::wcscmp(argv[1], kProtocolFlag) == 0 &&
         std::wcscmp(argv[2], kProtocolVersion) == 0;
}

// A resposta só vai para um pipe (o executor do app); nunca para arquivo ou console.
HANDLE OutputPipe() {
  HANDLE output = ::GetStdHandle(STD_OUTPUT_HANDLE);
  if (output == nullptr || output == INVALID_HANDLE_VALUE) return nullptr;
  if (::GetFileType(output) != FILE_TYPE_PIPE) return nullptr;
  return output;
}

bool WriteAll(HANDLE output, const char* data, std::size_t size) {
  while (size > 0) {
    const DWORD chunk = size > 0x10000u ? 0x10000u : static_cast<DWORD>(size);
    DWORD written = 0;
    if (!::WriteFile(output, data, chunk, &written, nullptr) || written == 0) return false;
    data += written;
    size -= written;
  }
  return true;
}

// Armazenamento estático: nenhuma alocação dinâmica pelo auxiliar.
gerpro::AdapterSet g_adapters;
gerpro::JsonBuffer g_response;

int Run(int argc, wchar_t** argv) {
  // Nenhuma caixa de diálogo do sistema em falhas (o processo não tem janela).
  ::SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);

  // Antes de qualquer outra coisa: linha de comando diferente não carrega nada.
  if (!ArgumentsAreExact(argc, argv)) return kExitUsage;

  HANDLE output = OutputPipe();
  if (output == nullptr) return kExitOutputFailed;

  if (!gerpro::HardenLibraryLoading()) return kExitDxcoreUnavailable;

  gerpro::DxcoreLibrary library = {};
  if (!gerpro::LoadDxcore(library)) return kExitDxcoreUnavailable;

  // As interfaces COM são liberadas dentro de EnumerateAdapters (ComPtr), antes
  // de a DLL ser liberada.
  const gerpro::EnumerationStatus status = gerpro::EnumerateAdapters(library, g_adapters);
  gerpro::UnloadDxcore(library);
  if (status == gerpro::EnumerationStatus::FactoryFailed) return kExitFactoryFailed;
  if (status != gerpro::EnumerationStatus::Ok) return kExitEnumerationFailed;

  // A resposta é montada inteira antes de qualquer escrita: falha detectada
  // aqui não deixa saída parcial.
  if (!gerpro::SerializeResponse(g_adapters.items, g_adapters.count, g_response)) return kExitOutputFailed;
  if (!WriteAll(output, g_response.Data(), g_response.Size())) return kExitOutputFailed;
  return kExitOk;
}

}  // namespace

int wmain(int argc, wchar_t** argv) { return Run(argc, argv); }
