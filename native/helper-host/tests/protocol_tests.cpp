// Testes da lógica pura do launcher (protocol.cpp): argumentos, hash em
// texto, comparação de resumos, repasse de códigos e montagem de caminhos.
// Não cria processos nem jobs, não abre arquivos, não lê hardware. Saída: uma
// linha por falha e um resumo; código 0 só se tudo passar.

#include <cstdio>
#include <cstring>
#include <cwchar>

#include "../src/exit_codes.h"
#include "../src/protocol.h"

using namespace gerpro::host;

namespace {

int g_checks = 0;
int g_failures = 0;

void Check(bool ok, const char* expression, int line) {
  ++g_checks;
  if (!ok) {
    ++g_failures;
    std::printf("FALHA linha %d: %s\n", line, expression);
  }
}

#define CHECK(condition) Check((condition), #condition, __LINE__)

constexpr wchar_t kHash[] = L"d2e3aabcbec2a462af1c237b7f8c4d35d0b0b698f18a67748a2efc899d84b13b";

void TestArguments() {
  std::uint8_t out[kSha256Bytes] = {};
  const wchar_t* good[] = {L"host.exe", L"--protocol", L"1", L"--helper-sha256", kHash};
  CHECK(ParseArguments(5, good, out));
  CHECK(out[0] == 0xd2 && out[1] == 0xe3 && out[31] == 0x3b);

  const wchar_t* fewer[] = {L"host.exe", L"--protocol", L"1", L"--helper-sha256"};
  CHECK(!ParseArguments(4, fewer, out));
  const wchar_t* more[] = {L"host.exe", L"--protocol", L"1", L"--helper-sha256", kHash, L"x"};
  CHECK(!ParseArguments(6, more, out));
  const wchar_t* order[] = {L"host.exe", L"--helper-sha256", kHash, L"--protocol", L"1"};
  CHECK(!ParseArguments(5, order, out));
  const wchar_t* version[] = {L"host.exe", L"--protocol", L"2", L"--helper-sha256", kHash};
  CHECK(!ParseArguments(5, version, out));
  const wchar_t* flag[] = {L"host.exe", L"--protocol", L"1", L"--helper-SHA256", kHash};
  CHECK(!ParseArguments(5, flag, out));
  const wchar_t* path[] = {L"host.exe", L"--protocol", L"1", L"--helper-sha256", L"C:\\outro.exe"};
  CHECK(!ParseArguments(5, path, out));
  const wchar_t* nulls[] = {L"host.exe", nullptr, L"1", L"--helper-sha256", kHash};
  CHECK(!ParseArguments(5, nulls, out));
  CHECK(!ParseArguments(5, nullptr, out));
}

void TestHex() {
  std::uint8_t out[kSha256Bytes] = {};
  CHECK(ParseSha256Hex(kHash, out));
  CHECK(!ParseSha256Hex(L"D2E3AABCBEC2A462AF1C237B7F8C4D35D0B0B698F18A67748A2EFC899D84B13B", out));  // maiúsculas
  CHECK(!ParseSha256Hex(L"d2e3aabcbec2a462af1c237b7f8c4d35d0b0b698f18a67748a2efc899d84b13", out));   // 63
  CHECK(!ParseSha256Hex(L"d2e3aabcbec2a462af1c237b7f8c4d35d0b0b698f18a67748a2efc899d84b13b0", out)); // 65
  CHECK(!ParseSha256Hex(L"g2e3aabcbec2a462af1c237b7f8c4d35d0b0b698f18a67748a2efc899d84b13b", out));
  CHECK(!ParseSha256Hex(L" d2e3aabcbec2a462af1c237b7f8c4d35d0b0b698f18a67748a2efc899d84b13", out));
  CHECK(!ParseSha256Hex(L"", out));
  CHECK(!ParseSha256Hex(nullptr, out));
}

void TestDigest() {
  std::uint8_t a[kSha256Bytes] = {};
  std::uint8_t b[kSha256Bytes] = {};
  CHECK(DigestEquals(a, b));
  b[31] = 1;
  CHECK(!DigestEquals(a, b));
  b[31] = 0;
  b[0] = 0x80;
  CHECK(!DigestEquals(a, b));
}

void TestDigestInSet() {
  std::uint8_t set[3][kSha256Bytes] = {};
  set[0][0] = 1;
  set[1][0] = 2;
  set[2][31] = 3;
  std::uint8_t probe[kSha256Bytes] = {};
  CHECK(!DigestInSet(probe, set, 3));  // zero não está no conjunto
  probe[31] = 3;
  CHECK(DigestInSet(probe, set, 3));   // último
  CHECK(!DigestInSet(probe, set, 2));  // fora da contagem
  probe[31] = 0;
  probe[0] = 1;
  CHECK(DigestInSet(probe, set, 3));   // primeiro
  CHECK(!DigestInSet(probe, set, 0));
  CHECK(!DigestInSet(probe, nullptr, 3));
}

void TestExitMapping() {
  CHECK(MapHelperExit(0) == 0);
  CHECK(MapHelperExit(10) == 10);
  CHECK(MapHelperExit(11) == 11);
  CHECK(MapHelperExit(12) == 12);
  CHECK(MapHelperExit(13) == 13);
  CHECK(MapHelperExit(64) == 64);
  CHECK(MapHelperExit(1) == kExitHostContainment);
  CHECK(MapHelperExit(20) == kExitHostContainment);  // códigos do launcher nunca vêm do auxiliar
  CHECK(MapHelperExit(29) == kExitHostContainment);
  CHECK(MapHelperExit(0xC0000005ul) == kExitHostContainment);  // exceção do Windows
  CHECK(MapHelperExit(0xFFFFFFFFul) == kExitHostContainment);
}

void TestFinalPath() {
  CHECK(std::wcscmp(StripFinalPathPrefix(L"\\\\?\\C:\\App\\x.exe"), L"C:\\App\\x.exe") == 0);
  CHECK(StripFinalPathPrefix(L"\\\\?\\UNC\\servidor\\x.exe") == nullptr);
  CHECK(StripFinalPathPrefix(L"\\\\.\\C:\\x.exe") == nullptr);
  CHECK(StripFinalPathPrefix(L"C:\\x.exe") == nullptr);
  CHECK(StripFinalPathPrefix(L"\\\\?\\Volume{0}\\x") == nullptr);
  CHECK(StripFinalPathPrefix(nullptr) == nullptr);
  CHECK(PathsEqual(L"C:\\Program Files\\App", L"c:\\program files\\APP"));
  CHECK(!PathsEqual(L"C:\\App", L"C:\\App\\"));
  CHECK(!PathsEqual(L"C:\\App", nullptr));
}

#if !defined(GERPRO_HOST_TEST_BUILD)
void TestLayout() {
  wchar_t arch[kMaxPathChars];
  wchar_t helpers[kMaxPathChars];
  wchar_t helper[kMaxPathChars];
  CHECK(ResolveLayout(L"C:\\Program Files\\Gerpro Studio\\resources\\helpers\\win32-x64\\gerpro-helper-host.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(std::wcscmp(arch, L"C:\\Program Files\\Gerpro Studio\\resources\\helpers\\win32-x64") == 0);
  CHECK(std::wcscmp(helpers, L"C:\\Program Files\\Gerpro Studio\\resources\\helpers") == 0);
  CHECK(std::wcscmp(helper, L"C:\\Program Files\\Gerpro Studio\\resources\\helpers\\win32-x64\\gerpro-dxcore-helper.exe") == 0);
  // Maiúsculas diferentes são aceitas (sistema de arquivos sem diferenciar).
  CHECK(ResolveLayout(L"C:\\R\\Helpers\\WIN32-X64\\Gerpro-Helper-Host.exe", arch, helpers, helper, kMaxPathChars));
  // Nome, pasta da arquitetura, pasta helpers, raiz e formato.
  CHECK(!ResolveLayout(L"C:\\R\\helpers\\win32-x64\\outro.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(!ResolveLayout(L"C:\\R\\helpers\\win32-arm64\\gerpro-helper-host.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(!ResolveLayout(L"C:\\R\\outros\\win32-x64\\gerpro-helper-host.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(!ResolveLayout(L"C:\\helpers\\win32-x64\\gerpro-helper-host.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(!ResolveLayout(L"\\\\servidor\\R\\helpers\\win32-x64\\gerpro-helper-host.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(!ResolveLayout(L"gerpro-helper-host.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(!ResolveLayout(nullptr, arch, helpers, helper, kMaxPathChars));
  // Buffer pequeno demais: recusa, sem estouro.
  wchar_t tiny[16];
  CHECK(!ResolveLayout(L"C:\\R\\helpers\\win32-x64\\gerpro-helper-host.exe", tiny, helpers, helper, 16));
  // Layout da variante de testes: recusado pelo launcher de produção.
  CHECK(!ResolveLayout(L"C:\\T\\host-test\\win32-x64\\gerpro-helper-host-test.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(!ResolveLayout(L"C:\\T\\helpers\\win32-x64\\gerpro-helper-host-test.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(!ResolveLayout(L"C:\\T\\host-test\\win32-x64\\gerpro-helper-host.exe", arch, helpers, helper, kMaxPathChars));
}
#else
// Variante de testes: só o próprio layout; o de produção é recusado.
void TestLayout() {
  wchar_t arch[kMaxPathChars];
  wchar_t helpers[kMaxPathChars];
  wchar_t helper[kMaxPathChars];
  CHECK(ResolveLayout(L"C:\\T\\gerpro-6c6c\\host-test\\win32-x64\\gerpro-helper-host-test.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(std::wcscmp(arch, L"C:\\T\\gerpro-6c6c\\host-test\\win32-x64") == 0);
  CHECK(std::wcscmp(helpers, L"C:\\T\\gerpro-6c6c\\host-test") == 0);
  CHECK(std::wcscmp(helper, L"C:\\T\\gerpro-6c6c\\host-test\\win32-x64\\gerpro-synthetic-helper.exe") == 0);
  CHECK(!ResolveLayout(L"C:\\R\\helpers\\win32-x64\\gerpro-helper-host.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(!ResolveLayout(L"C:\\R\\helpers\\win32-x64\\gerpro-helper-host-test.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(!ResolveLayout(L"C:\\R\\host-test\\win32-x64\\gerpro-helper-host.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(!ResolveLayout(L"C:\\host-test\\win32-x64\\gerpro-helper-host-test.exe", arch, helpers, helper, kMaxPathChars));
  CHECK(std::wcscmp(kHelperFileName, L"gerpro-synthetic-helper.exe") == 0);
  CHECK(std::wcscmp(kHelperFileName, L"gerpro-dxcore-helper.exe") != 0);
}
#endif

void TestConcat() {
  wchar_t out[8];
  CHECK(Concat(out, 8, L"abc", L"def"));
  CHECK(std::wcscmp(out, L"abcdef") == 0);
  CHECK(!Concat(out, 8, L"abcd", L"efgh"));
  CHECK(Concat(out, 8, out, L"g"));
  CHECK(std::wcscmp(out, L"abcdefg") == 0);
  CHECK(BoundedLength(L"abc", 2) == 2);
  CHECK(BoundedLength(nullptr, 2) == 0);
}

void TestCodes() {
  // Iguais à tabela 11.6 e a DXCORE_HOST_EXIT_CODES.
  CHECK(kExitHostArguments == 20 && kExitHostEnvironment == 21 && kExitHostJob == 22 && kExitHostFile == 23);
  CHECK(kExitHostIntegrity == 24 && kExitHostCreate == 25 && kExitHostVerify == 26 && kExitHostTimeout == 27);
  CHECK(kExitHostContainment == 28 && kExitHostUnconfirmed == 29);
}

}  // namespace

int main() {
  TestArguments();
  TestHex();
  TestDigest();
  TestDigestInSet();
  TestExitMapping();
  TestFinalPath();
  TestLayout();
  TestConcat();
  TestCodes();
  std::printf("%d verificações, %d falhas\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
