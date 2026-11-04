// Carregamento de dxcore.dll exclusivamente da pasta do sistema.

#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

namespace gerpro {

// Assinatura de DXCoreCreateAdapterFactory (forma não template de <dxcore.h>).
// dxcore_loader.cpp confere, em tempo de compilação, que ela é idêntica à
// declaração oficial do SDK.
using CreateAdapterFactoryFn = HRESULT(STDAPICALLTYPE*)(REFIID riid, void** factory);

struct DxcoreLibrary {
  HMODULE module;
  CreateAdapterFactoryFn createAdapterFactory;
};

// Restringe a busca de DLLs do processo à pasta do sistema e aplica as
// proteções de carregamento. Tem de ser chamada antes de qualquer carga.
// `false`: alguma proteção obrigatória não pôde ser estabelecida.
bool HardenLibraryLoading();

// Carrega dxcore.dll só da pasta do sistema e obtém a função de fábrica.
// `false`: DLL ausente ou sem a função (Windows sem DXCore).
bool LoadDxcore(DxcoreLibrary& library);

// Libera a DLL. Só depois de liberadas todas as interfaces obtidas dela.
void UnloadDxcore(DxcoreLibrary& library);

}  // namespace gerpro
