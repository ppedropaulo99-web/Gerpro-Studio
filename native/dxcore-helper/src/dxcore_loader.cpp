// Carregamento de dxcore.dll exclusivamente da pasta do sistema.
//
// Nada aqui depende de caminho fornecido por quem chama: o nome da DLL é fixo
// e a busca fica restrita à System32 (LOAD_LIBRARY_SEARCH_SYSTEM32), tanto
// para a própria DLL quanto para as dependências dela.

#include "dxcore_loader.h"

#include <dxcore.h>

#include <type_traits>

namespace gerpro {

// A assinatura usada no GetProcAddress tem de ser a do SDK: o static_cast só
// compila se a forma não template de <dxcore.h> tiver exatamente esse tipo
// (static_cast não converte entre ponteiros de função diferentes). A expressão
// fica dentro de decltype (não avaliada): não cria dependência de dxcore.lib.
static_assert(std::is_same<decltype(static_cast<CreateAdapterFactoryFn>(&::DXCoreCreateAdapterFactory)), CreateAdapterFactoryFn>::value,
              "assinatura de DXCoreCreateAdapterFactory diferente da do SDK");

bool HardenLibraryLoading() {
  // Busca padrão do processo: só a pasta do sistema. Vale para toda carga
  // posterior, inclusive as feitas por dxcore.dll.
  if (!::SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)) return false;

  // Imagens: nada de compartilhamento de rede, nada com rótulo de integridade
  // baixa, e preferência pela System32 quando o nome coincidir.
  PROCESS_MITIGATION_IMAGE_LOAD_POLICY image = {};
  image.NoRemoteImages = 1;
  image.NoLowMandatoryLabelImages = 1;
  image.PreferSystem32Images = 1;
  if (!::SetProcessMitigationPolicy(ProcessImageLoadPolicy, &image, sizeof(image))) return false;

  // Pontos de extensão antigos (AppInit_DLLs, ganchos globais e similares).
  PROCESS_MITIGATION_EXTENSION_POINT_DISABLE_POLICY extensions = {};
  extensions.DisableExtensionPoints = 1;
  if (!::SetProcessMitigationPolicy(ProcessExtensionPointDisablePolicy, &extensions, sizeof(extensions))) return false;

  // Uso de handle inválido encerra o processo em vez de seguir adiante.
  PROCESS_MITIGATION_STRICT_HANDLE_CHECK_POLICY handles = {};
  handles.RaiseExceptionOnInvalidHandleReference = 1;
  handles.HandleExceptionsPermanentlyEnabled = 1;
  if (!::SetProcessMitigationPolicy(ProcessStrictHandleCheckPolicy, &handles, sizeof(handles))) return false;

  // Não ativados nesta versão (decisão da 6C.3B.1): MicrosoftSignedOnly e
  // ProhibitDynamicCode, que podem impedir componentes do driver.
  return true;
}

bool LoadDxcore(DxcoreLibrary& library) {
  library.module = nullptr;
  library.createAdapterFactory = nullptr;

  HMODULE module = ::LoadLibraryExW(L"dxcore.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (module == nullptr) return false;

  FARPROC proc = ::GetProcAddress(module, "DXCoreCreateAdapterFactory");
  if (proc == nullptr) {
    ::FreeLibrary(module);
    return false;
  }
  library.module = module;
  library.createAdapterFactory = reinterpret_cast<CreateAdapterFactoryFn>(reinterpret_cast<void*>(proc));
  return true;
}

void UnloadDxcore(DxcoreLibrary& library) {
  if (library.module != nullptr) ::FreeLibrary(library.module);
  library.module = nullptr;
  library.createAdapterFactory = nullptr;
}

}  // namespace gerpro
