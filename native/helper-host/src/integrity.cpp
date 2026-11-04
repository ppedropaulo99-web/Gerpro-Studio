#include "integrity.h"

#include <bcrypt.h>

namespace gerpro {
namespace host {

namespace {

// Buffer estático de leitura: nenhuma alocação dinâmica pelo launcher.
constexpr DWORD kChunkBytes = 64 * 1024;
std::uint8_t g_chunk[kChunkBytes];

}  // namespace

bool HashOpenFile(HANDLE file, ULONGLONG expectedSize, std::uint8_t (&digest)[kSha256Bytes]) {
  if (file == nullptr || file == INVALID_HANDLE_VALUE) return false;

  LARGE_INTEGER size = {};
  if (!::GetFileSizeEx(file, &size) || size.QuadPart < 0 || static_cast<ULONGLONG>(size.QuadPart) != expectedSize) return false;

  LARGE_INTEGER start = {};
  if (!::SetFilePointerEx(file, start, nullptr, FILE_BEGIN)) return false;

  // Pseudo-identificador do provedor SHA-256 (Windows 10+): nada é carregado
  // além de bcrypt.dll, importada da System32.
  BCRYPT_HASH_HANDLE hash = nullptr;
  if (!BCRYPT_SUCCESS(::BCryptCreateHash(BCRYPT_SHA256_ALG_HANDLE, &hash, nullptr, 0, nullptr, 0, 0))) return false;

  bool ok = true;
  ULONGLONG total = 0;
  for (;;) {
    DWORD read = 0;
    if (!::ReadFile(file, g_chunk, kChunkBytes, &read, nullptr)) {
      ok = false;
      break;
    }
    if (read == 0) break;  // fim do arquivo
    total += read;
    if (total > expectedSize || !BCRYPT_SUCCESS(::BCryptHashData(hash, g_chunk, read, 0))) {
      ok = false;
      break;
    }
  }
  if (ok && total != expectedSize) ok = false;
  if (ok && !BCRYPT_SUCCESS(::BCryptFinishHash(hash, digest, static_cast<ULONG>(kSha256Bytes), 0))) ok = false;
  ::BCryptDestroyHash(hash);
  ::SecureZeroMemory(g_chunk, sizeof(g_chunk));
  return ok;
}

}  // namespace host
}  // namespace gerpro
