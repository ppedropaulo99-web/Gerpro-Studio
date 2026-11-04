#include "protocol.h"

#include <cwchar>

#include "exit_codes.h"

namespace gerpro {
namespace host {

namespace {

int HexValue(wchar_t c) {
  if (c >= L'0' && c <= L'9') return c - L'0';
  if (c >= L'a' && c <= L'f') return c - L'a' + 10;
  return -1;  // maiúsculas e qualquer outro caractere são recusados
}

bool Equals(const wchar_t* a, const wchar_t* b) { return a != nullptr && b != nullptr && std::wcscmp(a, b) == 0; }

// Último separador "\" antes de `end` (exclusivo); -1 se não houver.
long LastSeparator(const wchar_t* text, std::size_t end) {
  for (std::size_t i = end; i > 0; --i) {
    if (text[i - 1] == L'\\') return static_cast<long>(i - 1);
  }
  return -1;
}

bool SegmentEquals(const wchar_t* text, std::size_t start, std::size_t end, const wchar_t* expected) {
  const std::size_t length = end - start;
  if (length != std::wcslen(expected) || length > 0x7fffffff) return false;
  return ::CompareStringOrdinal(text + start, static_cast<int>(length), expected, static_cast<int>(length), TRUE) == CSTR_EQUAL;
}

bool CopyPrefix(wchar_t* out, std::size_t cap, const wchar_t* text, std::size_t length) {
  if (length + 1 > cap) return false;
  std::wmemcpy(out, text, length);
  out[length] = L'\0';
  return true;
}

}  // namespace

bool ParseArguments(int argc, const wchar_t* const* argv, std::uint8_t (&helperSha256)[kSha256Bytes]) {
  if (argc != 5 || argv == nullptr) return false;
  if (!Equals(argv[1], kProtocolFlag) || !Equals(argv[2], kProtocolVersion) || !Equals(argv[3], kHelperHashFlag)) return false;
  return ParseSha256Hex(argv[4], helperSha256);
}

bool ParseSha256Hex(const wchar_t* text, std::uint8_t (&out)[kSha256Bytes]) {
  if (text == nullptr || BoundedLength(text, kSha256HexChars + 1) != kSha256HexChars) return false;
  for (std::size_t i = 0; i < kSha256Bytes; ++i) {
    const int high = HexValue(text[2 * i]);
    const int low = HexValue(text[2 * i + 1]);
    if (high < 0 || low < 0) return false;
    out[i] = static_cast<std::uint8_t>((high << 4) | low);
  }
  return true;
}

bool DigestEquals(const std::uint8_t (&a)[kSha256Bytes], const std::uint8_t (&b)[kSha256Bytes]) {
  unsigned difference = 0;
  for (std::size_t i = 0; i < kSha256Bytes; ++i) difference |= static_cast<unsigned>(a[i] ^ b[i]);
  return difference == 0;
}

bool DigestInSet(const std::uint8_t (&digest)[kSha256Bytes], const std::uint8_t (*set)[kSha256Bytes], std::size_t count) {
  if (set == nullptr) return false;
  bool found = false;
  for (std::size_t i = 0; i < count; ++i) found = DigestEquals(digest, set[i]) || found;
  return found;
}

int MapHelperExit(DWORD helperExitCode) {
  for (unsigned long code : kHelperContractCodes) {
    if (helperExitCode == code) return static_cast<int>(code);
  }
  return kExitHostContainment;
}

const wchar_t* StripFinalPathPrefix(const wchar_t* finalPath) {
  if (finalPath == nullptr) return nullptr;
  // "\\?\" + letra + ":\"
  if (BoundedLength(finalPath, 8) < 7) return nullptr;
  if (finalPath[0] != L'\\' || finalPath[1] != L'\\' || finalPath[2] != L'?' || finalPath[3] != L'\\') return nullptr;
  const wchar_t drive = finalPath[4];
  const bool letter = (drive >= L'A' && drive <= L'Z') || (drive >= L'a' && drive <= L'z');
  if (!letter || finalPath[5] != L':' || finalPath[6] != L'\\') return nullptr;
  return finalPath + 4;
}

bool PathsEqual(const wchar_t* a, const wchar_t* b) {
  if (a == nullptr || b == nullptr) return false;
  const std::size_t la = BoundedLength(a, kMaxPathChars);
  const std::size_t lb = BoundedLength(b, kMaxPathChars);
  if (la != lb || la >= kMaxPathChars) return false;
  return ::CompareStringOrdinal(a, static_cast<int>(la), b, static_cast<int>(lb), TRUE) == CSTR_EQUAL;
}

std::size_t BoundedLength(const wchar_t* text, std::size_t cap) {
  if (text == nullptr) return 0;
  std::size_t n = 0;
  while (n < cap && text[n] != L'\0') ++n;
  return n;
}

bool ResolveLayout(const wchar_t* hostPath, wchar_t* archDir, wchar_t* helpersDir, wchar_t* helperPath, std::size_t cap) {
  if (hostPath == nullptr || archDir == nullptr || helpersDir == nullptr || helperPath == nullptr) return false;
  const std::size_t length = BoundedLength(hostPath, kMaxPathChars);
  if (length == 0 || length >= kMaxPathChars) return false;
  // Caminho local absoluto "X:\...".
  const wchar_t drive = hostPath[0];
  const bool letter = (drive >= L'A' && drive <= L'Z') || (drive >= L'a' && drive <= L'z');
  if (length < 3 || !letter || hostPath[1] != L':' || hostPath[2] != L'\\') return false;

  const long fileSep = LastSeparator(hostPath, length);
  if (fileSep < 0 || !SegmentEquals(hostPath, static_cast<std::size_t>(fileSep) + 1, length, kHostFileName)) return false;
  const long archSep = LastSeparator(hostPath, static_cast<std::size_t>(fileSep));
  if (archSep < 0 || !SegmentEquals(hostPath, static_cast<std::size_t>(archSep) + 1, static_cast<std::size_t>(fileSep), kArchDirectory)) return false;
  const long helpersSep = LastSeparator(hostPath, static_cast<std::size_t>(archSep));
  // A pasta "helpers" não pode ser a raiz da unidade: precisa de uma pasta de recursos acima dela.
  if (helpersSep < 3 || !SegmentEquals(hostPath, static_cast<std::size_t>(helpersSep) + 1, static_cast<std::size_t>(archSep), kHelpersDirectory)) return false;

  if (!CopyPrefix(archDir, cap, hostPath, static_cast<std::size_t>(fileSep))) return false;
  if (!CopyPrefix(helpersDir, cap, hostPath, static_cast<std::size_t>(archSep))) return false;
  if (!CopyPrefix(helperPath, cap, hostPath, static_cast<std::size_t>(fileSep) + 1)) return false;
  return Concat(helperPath, cap, helperPath, kHelperFileName);
}

bool Concat(wchar_t* out, std::size_t cap, const wchar_t* a, const wchar_t* b) {
  if (out == nullptr || a == nullptr || b == nullptr || cap == 0) return false;
  const std::size_t la = BoundedLength(a, cap);
  const std::size_t lb = BoundedLength(b, cap);
  if (la + lb + 1 > cap) return false;
  if (out != a) std::wmemmove(out, a, la);
  std::wmemmove(out + la, b, lb);
  out[la + lb] = L'\0';
  return true;
}

}  // namespace host
}  // namespace gerpro
