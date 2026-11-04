// SHA-256 de um arquivo pelo identificador já aberto (BCrypt, provedor do
// sistema). O arquivo é lido do início ao fim pelo MESMO identificador que o
// mantém travado; nenhum caminho é reaberto aqui.

#pragma once

#include <windows.h>

#include <cstdint>

#include "protocol.h"

namespace gerpro {
namespace host {

// Lê exatamente `expectedSize` bytes a partir do início e calcula o SHA-256.
// Falso em qualquer erro, tamanho diferente ou bytes além do esperado.
bool HashOpenFile(HANDLE file, ULONGLONG expectedSize, std::uint8_t (&digest)[kSha256Bytes]);

}  // namespace host
}  // namespace gerpro
