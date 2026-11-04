// Lógica pura do launcher: argumentos, hash em texto, comparação de resumos,
// caminhos e repasse do código do auxiliar. Nada aqui cria processo, abre
// arquivo ou altera o estado do sistema; por isso é coberto por
// tests/protocol_tests.cpp.

#pragma once

#include <windows.h>

#include <cstddef>
#include <cstdint>

namespace gerpro {
namespace host {

constexpr std::size_t kSha256Bytes = 32;
constexpr std::size_t kSha256HexChars = 64;
// Capacidade dos buffers de caminho (caracteres, com o NUL). O app recusa
// raízes acima de 240 caracteres; o restante do caminho é fixo.
constexpr std::size_t kMaxPathChars = 1024;

// Argumentos fixos (iguais a DXCORE_HOST_ARGS_PREFIX).
constexpr wchar_t kProtocolFlag[] = L"--protocol";
constexpr wchar_t kProtocolVersion[] = L"1";
constexpr wchar_t kHelperHashFlag[] = L"--helper-sha256";

#if !defined(GERPRO_HOST_TEST_BUILD)
// Identidade fixa (iguais a DXCORE_HOST em dxcore-host-contract.ts).
constexpr wchar_t kHostFileName[] = L"gerpro-helper-host.exe";
constexpr wchar_t kHelperFileName[] = L"gerpro-dxcore-helper.exe";
constexpr wchar_t kHelpersDirectory[] = L"helpers";
#else
// VARIANTE DE TESTES (6C.6C.1; docs/11): só com /DGERPRO_HOST_TEST_BUILD,
// definido apenas por scripts/native/build-host-test-artifacts.mjs. Outro
// nome do launcher, outro alvo e outra pasta: nenhuma das duas variantes
// encontra o executável da outra. Nunca distribuída.
constexpr wchar_t kHostFileName[] = L"gerpro-helper-host-test.exe";
constexpr wchar_t kHelperFileName[] = L"gerpro-synthetic-helper.exe";
constexpr wchar_t kHelpersDirectory[] = L"host-test";
#endif
#if defined(_M_X64)
constexpr wchar_t kArchDirectory[] = L"win32-x64";
#elif defined(_M_ARM64)
constexpr wchar_t kArchDirectory[] = L"win32-arm64";
#else
#error "arquitetura não suportada"
#endif

// Exatamente: <exe> --protocol 1 --helper-sha256 <64 hex minúsculos>.
bool ParseArguments(int argc, const wchar_t* const* argv, std::uint8_t (&helperSha256)[kSha256Bytes]);

// 64 dígitos hexadecimais minúsculos, nada antes nem depois.
bool ParseSha256Hex(const wchar_t* text, std::uint8_t (&out)[kSha256Bytes]);

// Comparação em tempo constante.
bool DigestEquals(const std::uint8_t (&a)[kSha256Bytes], const std::uint8_t (&b)[kSha256Bytes]);

// Verdadeiro se `digest` é um dos `count` resumos de `set` (cada comparação em
// tempo constante). Usado só pela variante de testes, para aceitar apenas os
// auxiliares sintéticos fixados no build.
bool DigestInSet(const std::uint8_t (&digest)[kSha256Bytes], const std::uint8_t (*set)[kSha256Bytes], std::size_t count);

// Código do auxiliar dentro do contrato → o próprio código; qualquer outro
// (inclusive exceção do Windows) → kExitHostContainment.
int MapHelperExit(DWORD helperExitCode);

// Caminho de GetFinalPathNameByHandleW: aceita só "\\?\X:\..." e devolve a
// parte "X:\..."; nulo para rede (\\?\UNC\), dispositivo ou outro formato.
const wchar_t* StripFinalPathPrefix(const wchar_t* finalPath);

// Igualdade sem diferenciar maiúsculas (ordinal, como o sistema de arquivos).
bool PathsEqual(const wchar_t* a, const wchar_t* b);

// Comprimento seguro (nunca passa de cap); cap → sem NUL dentro do limite.
std::size_t BoundedLength(const wchar_t* text, std::size_t cap);

// A partir do caminho do próprio launcher ("X:\...\helpers\win32-<arch>\
// gerpro-helper-host.exe"): confere nome e as duas pastas finais e monta a
// pasta do auxiliar, a pasta "helpers" e o caminho do auxiliar.
bool ResolveLayout(const wchar_t* hostPath, wchar_t* archDir, wchar_t* helpersDir, wchar_t* helperPath, std::size_t cap);

// out = a + b (cópia limitada). Falso se não couber.
bool Concat(wchar_t* out, std::size_t cap, const wchar_t* a, const wchar_t* b);

}  // namespace host
}  // namespace gerpro
