// Testes do serializador e da sanitização da descrição, só com adaptadores
// SIMULADOS. Não inclui <dxcore.h>, não carrega dxcore.dll, não lê hardware,
// não grava arquivos. Saída: uma linha por falha e um resumo; código 0 só se
// tudo passar.
//
// As respostas esperadas ficam em literais R"golden(...)golden": o teste
// TypeScript tests/main/dxcore-native-sources.test.ts extrai esses mesmos
// textos e confere que o parser do app os aceita.

#include <cstdint>
#include <cstdio>
#include <cstring>

#include "../src/adapters.h"
#include "../src/description.h"
#include "../src/json_writer.h"

using namespace gerpro;

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

// Buffers estáticos: 64 KiB cada.
JsonBuffer g_out;
JsonBuffer g_small(64);
AdapterRecord g_records[kMaxAdapters + 1];

// Resposta igual ao golden seguido de uma única quebra de linha.
bool MatchesGolden(const JsonBuffer& out, const char* golden) {
  const std::size_t length = std::strlen(golden);
  return !out.Failed() && out.Size() == length + 1 && std::memcmp(out.Data(), golden, length) == 0 && out.Data()[length] == '\n';
}

void SetDescription(AdapterRecord& record, const char16_t* units, std::size_t length) {
  record.hasDescription = true;
  record.descriptionLength = length;
  for (std::size_t i = 0; i < length && i < kMaxDescriptionUnits; ++i) record.description[i] = units[i];
}

AdapterRecord Typical() {
  AdapterRecord r = {};
  r.hasLuid = true;
  r.luidHigh = 0x00000000u;
  r.luidLow = 0x0000ABCDu;
  r.hasHardwareId = true;
  r.vendorId = 4318;
  r.deviceId = 9637;
  const char16_t name[] = u"NVIDIA GeForce RTX 3050 Laptop GPU";
  SetDescription(r, name, sizeof(name) / sizeof(name[0]) - 1);
  r.isHardware = OptionalBool{true, true};
  r.isIntegrated = OptionalBool{true, false};
  r.dedicatedAdapterMemory = OptionalUint64{true, 4148166656ull};
  r.dedicatedSystemMemory = OptionalUint64{true, 0ull};
  r.sharedSystemMemory = OptionalUint64{true, 8530190336ull};
  return r;
}

// ── Números e LUID ───────────────────────────────────────────────────────────

void TestUint64() {
  char digits[kUint64Digits];
  std::size_t n = FormatUint64(0u, digits);
  CHECK(n == 1 && std::memcmp(digits, "0", 1) == 0);
  n = FormatUint64(1u, digits);
  CHECK(n == 1 && std::memcmp(digits, "1", 1) == 0);
  n = FormatUint64(10u, digits);
  CHECK(n == 2 && std::memcmp(digits, "10", 2) == 0);
  // 2^53 + 1: um double arredondaria.
  n = FormatUint64(9007199254740993ull, digits);
  CHECK(n == 16 && std::memcmp(digits, "9007199254740993", 16) == 0);
  n = FormatUint64(18446744073709551615ull, digits);
  CHECK(n == 20 && std::memcmp(digits, "18446744073709551615", 20) == 0);
  n = FormatUint32(4294967295u, digits);
  CHECK(n == 10 && std::memcmp(digits, "4294967295", 10) == 0);
}

void TestLuid() {
  char text[kLuidChars];
  FormatLuid(0x00000000u, 0x0000ABCDu, text);
  CHECK(std::memcmp(text, "00000000:0000ABCD", kLuidChars) == 0);
  // HighPart negativo (LONG -2) reinterpretado como 32 bits sem sinal.
  FormatLuid(static_cast<std::uint32_t>(static_cast<std::int32_t>(-2)), 0x00000001u, text);
  CHECK(std::memcmp(text, "FFFFFFFE:00000001", kLuidChars) == 0);
  FormatLuid(0x80000000u, 0xFFFFFFFFu, text);
  CHECK(std::memcmp(text, "80000000:FFFFFFFF", kLuidChars) == 0);
  FormatLuid(0u, 0u, text);
  CHECK(std::memcmp(text, "00000000:00000000", kLuidChars) == 0);
  FormatLuid(0x0123ABCDu, 0xFEDC9876u, text);
  CHECK(std::memcmp(text, "0123ABCD:FEDC9876", kLuidChars) == 0);
}

// ── Respostas completas (goldens) ────────────────────────────────────────────

void TestMinimal() {
  CHECK(SerializeResponse(nullptr, 0, g_out));
  CHECK(MatchesGolden(g_out, R"golden({"protocol":"gerpro.dxcore-adapters","version":1,"adapters":[]})golden"));
}

void TestTypical() {
  g_records[0] = Typical();
  CHECK(SerializeResponse(g_records, 1, g_out));
  CHECK(MatchesGolden(
      g_out,
      R"golden({"protocol":"gerpro.dxcore-adapters","version":1,"adapters":[{"luid":"00000000:0000ABCD","vendorId":4318,"deviceId":9637,"description":"NVIDIA GeForce RTX 3050 Laptop GPU","isHardware":true,"isIntegrated":false,"dedicatedAdapterMemory":"4148166656","dedicatedSystemMemory":"0","sharedSystemMemory":"8530190336"}]})golden"));
}

void TestUnavailableFields() {
  ClearRecord(g_records[0]);
  CHECK(SerializeResponse(g_records, 1, g_out));
  CHECK(MatchesGolden(
      g_out,
      R"golden({"protocol":"gerpro.dxcore-adapters","version":1,"adapters":[{"luid":null,"vendorId":null,"deviceId":null,"description":null,"isHardware":null,"isIntegrated":null,"dedicatedAdapterMemory":null,"dedicatedSystemMemory":null,"sharedSystemMemory":null}]})golden"));
}

void TestLimitsAndLuids() {
  AdapterRecord a = {};
  a.hasLuid = true;
  a.luidHigh = static_cast<std::uint32_t>(static_cast<std::int32_t>(-2));
  a.luidLow = 1u;
  a.hasHardwareId = true;
  a.vendorId = 4294967295u;
  a.deviceId = 0u;
  a.isHardware = OptionalBool{true, false};
  a.isIntegrated = OptionalBool{true, true};
  a.dedicatedAdapterMemory = OptionalUint64{true, 0ull};
  a.dedicatedSystemMemory = OptionalUint64{true, 9007199254740993ull};
  a.sharedSystemMemory = OptionalUint64{true, 18446744073709551615ull};

  AdapterRecord zero = {};
  zero.hasLuid = true;  // LUID zero é escrito; quem o recusa é a validação da lista no app.
  zero.isHardware = OptionalBool{true, true};

  AdapterRecord high = {};
  high.hasLuid = true;
  high.luidHigh = 0x80000000u;
  high.luidLow = 0xFFFFFFFFu;

  g_records[0] = a;
  g_records[1] = zero;
  g_records[2] = high;
  CHECK(SerializeResponse(g_records, 3, g_out));
  CHECK(MatchesGolden(
      g_out,
      R"golden({"protocol":"gerpro.dxcore-adapters","version":1,"adapters":[{"luid":"FFFFFFFE:00000001","vendorId":4294967295,"deviceId":0,"description":null,"isHardware":false,"isIntegrated":true,"dedicatedAdapterMemory":"0","dedicatedSystemMemory":"9007199254740993","sharedSystemMemory":"18446744073709551615"},{"luid":"00000000:00000000","vendorId":null,"deviceId":null,"description":null,"isHardware":true,"isIntegrated":null,"dedicatedAdapterMemory":null,"dedicatedSystemMemory":null,"sharedSystemMemory":null},{"luid":"80000000:FFFFFFFF","vendorId":null,"deviceId":null,"description":null,"isHardware":null,"isIntegrated":null,"dedicatedAdapterMemory":null,"dedicatedSystemMemory":null,"sharedSystemMemory":null}]})golden"));
}

void TestEscapes() {
  ClearRecord(g_records[0]);
  // Aspas, barra invertida, e-agudo, U+2028, U+1F600 (par substituto) e tabulação.
  const char16_t units[] = {u'A', u'"', u'B', u'\\', u'C', 0x00E9, 0x2028, 0xD83D, 0xDE00, 0x0009, u'/'};
  SetDescription(g_records[0], units, sizeof(units) / sizeof(units[0]));
  CHECK(SerializeResponse(g_records, 1, g_out));
  // Fora do CHECK: o pr\u00E9-processador tradicional do MSVC n\u00E3o reconhece
  // literal bruto com \" dentro de argumento de macro.
  static const char kGolden[] =
      R"golden({"protocol":"gerpro.dxcore-adapters","version":1,"adapters":[{"luid":null,"vendorId":null,"deviceId":null,"description":"A\"B\\C\u00E9\u2028\uD83D\uDE00\u0009/","isHardware":null,"isIntegrated":null,"dedicatedAdapterMemory":null,"dedicatedSystemMemory":null,"sharedSystemMemory":null}]})golden";
  CHECK(MatchesGolden(g_out, kGolden));
  // Só ASCII na saída.
  bool ascii = true;
  for (std::size_t i = 0; i < g_out.Size(); ++i) ascii = ascii && static_cast<std::uint32_t>(static_cast<unsigned char>(g_out.Data()[i])) < 0x80u;
  CHECK(ascii);
}

void TestInvalidDescriptions() {
  // Descrição presente mas vazia: violação (deveria ser null).
  ClearRecord(g_records[0]);
  g_records[0].hasDescription = true;
  g_records[0].descriptionLength = 0;
  CHECK(!SerializeResponse(g_records, 1, g_out));

  // Substitutos isolados ou fora de ordem.
  const char16_t loneHigh[] = {u'A', 0xD83D};
  const char16_t loneLow[] = {0xDE00, u'A'};
  const char16_t highThenAscii[] = {0xD83D, u'A'};
  const char16_t reversed[] = {0xDE00, 0xD83D};
  const char16_t* cases[] = {loneHigh, loneLow, highThenAscii, reversed};
  for (const char16_t* units : cases) {
    ClearRecord(g_records[0]);
    SetDescription(g_records[0], units, 2);
    CHECK(!SerializeResponse(g_records, 1, g_out));
  }

  // 128 unidades: aceito; 129: violação.
  ClearRecord(g_records[0]);
  char16_t full[kMaxDescriptionUnits];
  for (char16_t& u : full) u = u'A';
  SetDescription(g_records[0], full, kMaxDescriptionUnits);
  CHECK(SerializeResponse(g_records, 1, g_out));
  g_records[0].descriptionLength = kMaxDescriptionUnits + 1;
  CHECK(!SerializeResponse(g_records, 1, g_out));
}

void TestSixteenAdapters() {
  // Pior caso: todos os campos no máximo e descrição de 128 unidades fora do ASCII.
  AdapterRecord worst = {};
  worst.hasLuid = true;
  worst.luidHigh = 0xFFFFFFFFu;
  worst.luidLow = 0xFFFFFFFFu;
  worst.hasHardwareId = true;
  worst.vendorId = 4294967295u;
  worst.deviceId = 4294967295u;
  char16_t units[kMaxDescriptionUnits];
  for (char16_t& u : units) u = 0x00E9;
  SetDescription(worst, units, kMaxDescriptionUnits);
  worst.isHardware = OptionalBool{true, false};
  worst.isIntegrated = OptionalBool{true, false};
  worst.dedicatedAdapterMemory = OptionalUint64{true, 18446744073709551615ull};
  worst.dedicatedSystemMemory = OptionalUint64{true, 18446744073709551615ull};
  worst.sharedSystemMemory = OptionalUint64{true, 18446744073709551615ull};
  for (AdapterRecord& r : g_records) r = worst;

  CHECK(SerializeResponse(g_records, kMaxAdapters, g_out));
  CHECK(g_out.Size() < kMaxOutputBytes);
  std::printf("pior caso com %u adaptadores: %u bytes\n", static_cast<unsigned>(kMaxAdapters), static_cast<unsigned>(g_out.Size()));

  // 17: recusado, mesmo cabendo no limite.
  CHECK(!SerializeResponse(g_records, kMaxAdapters + 1, g_out));
}

void TestBufferLimits() {
  JsonBuffer& b = g_small;
  b.Reset();
  for (int i = 0; i < 64; ++i) b.Put('x');
  CHECK(!b.Failed() && b.Size() == 64);
  b.Put('y');
  CHECK(b.Failed() && b.Size() == 64);
  b.Put('z');
  CHECK(b.Size() == 64);

  // Resposta mínima: 63 bytes + quebra de linha = 64. Cabe exatamente em 64,
  // não cabe em 63 (e o buffer com falha não deve ser escrito).
  CHECK(SerializeResponse(nullptr, 0, g_small));
  CHECK(g_small.Size() == 64);
  static JsonBuffer tight(63);
  CHECK(!SerializeResponse(nullptr, 0, tight));
  CHECK(tight.Failed());

  // O limite nunca passa de 64 KiB, mesmo se pedido maior.
  static JsonBuffer capped(1u << 20);
  for (std::size_t i = 0; i < kMaxOutputBytes; ++i) capped.Put(' ');
  CHECK(!capped.Failed());
  capped.Put(' ');
  CHECK(capped.Failed() && capped.Size() == kMaxOutputBytes);
}

void TestKeyOrder() {
  g_records[0] = Typical();
  CHECK(SerializeResponse(g_records, 1, g_out));
  const char* keys[] = {"\"protocol\":", "\"version\":", "\"adapters\":", "\"luid\":", "\"vendorId\":", "\"deviceId\":",
                        "\"description\":", "\"isHardware\":", "\"isIntegrated\":", "\"dedicatedAdapterMemory\":",
                        "\"dedicatedSystemMemory\":", "\"sharedSystemMemory\":"};
  // Buffer não é terminado em NUL: cópia limitada para a busca.
  static char text[kMaxOutputBytes + 1];
  std::memcpy(text, g_out.Data(), g_out.Size());
  text[g_out.Size()] = '\0';
  const char* previous = text;
  for (const char* key : keys) {
    const char* found = std::strstr(text, key);
    CHECK(found != nullptr && found >= previous);
    // Cada chave aparece uma única vez.
    CHECK(found != nullptr && std::strstr(found + 1, key) == nullptr);
    if (found != nullptr) previous = found;
  }
  // Sem espaços fora de strings e com uma única quebra de linha, no fim.
  CHECK(std::strchr(text, '\n') == text + g_out.Size() - 1);
  CHECK(std::strstr(text, "\": ") == nullptr && std::strstr(text, ", \"") == nullptr);
}

// ── Descrição: UTF-8 estrito e sanitização ───────────────────────────────────

bool Sanitized(const char* bytes, std::size_t length, const char16_t* expected) {
  char16_t out[kMaxDescriptionUnits];
  std::size_t outLength = 99;
  if (!SanitizeDescription(reinterpret_cast<const std::uint8_t*>(bytes), length, out, kMaxDescriptionUnits, outLength)) return false;
  std::size_t expectedLength = 0;
  while (expected[expectedLength] != 0) ++expectedLength;
  return outLength == expectedLength && std::memcmp(out, expected, expectedLength * sizeof(char16_t)) == 0;
}

bool Rejected(const char* bytes, std::size_t length) {
  char16_t out[kMaxDescriptionUnits];
  std::size_t outLength = 99;
  return !SanitizeDescription(reinterpret_cast<const std::uint8_t*>(bytes), length, out, kMaxDescriptionUnits, outLength) && outLength == 0;
}

void TestDescriptionDecoding() {
  // sizeof inclui o NUL final, como o tamanho informado pelo DXCore.
  const char ascii[] = "Intel(R) UHD Graphics";
  CHECK(Sanitized(ascii, sizeof(ascii), u"Intel(R) UHD Graphics"));
  const char accented[] = "Gr\xC3\xA1\x66icos";  // "Gráficos"
  CHECK(Sanitized(accented, sizeof(accented), u"Gr\u00E1ficos"));
  const char emoji[] = "GPU \xF0\x9F\x98\x80";  // U+1F600 -> par substituto
  const char16_t emojiUnits[] = {u'G', u'P', u'U', u' ', 0xD83D, 0xDE00, 0};
  CHECK(Sanitized(emoji, sizeof(emoji), emojiUnits));

  // NUL obrigatório dentro do tamanho; o que vem depois dele é ignorado.
  const char noNul[] = {'G', 'P', 'U'};
  CHECK(Rejected(noNul, sizeof(noNul)));
  const char afterNul[] = {'G', 'P', 'U', 0, '\xFF', 'X', 0};
  CHECK(Sanitized(afterNul, sizeof(afterNul), u"GPU"));

  // UTF-8 inválido em qualquer posição: descrição descartada.
  const char overlong[] = "A\xC0\x80";
  const char overlong3[] = "A\xE0\x80\xAF";
  const char surrogate[] = "A\xED\xA0\x80";
  const char aboveMax[] = "A\xF4\x90\x80\x80";
  const char truncated[] = "A\xE2\x82";
  const char stray[] = "A\x80";
  const char invalidLead[] = "A\xFF";
  const char badContinuation[] = "A\xC3\x41";
  CHECK(Rejected(overlong, sizeof(overlong)));
  CHECK(Rejected(overlong3, sizeof(overlong3)));
  CHECK(Rejected(surrogate, sizeof(surrogate)));
  CHECK(Rejected(aboveMax, sizeof(aboveMax)));
  CHECK(Rejected(truncated, sizeof(truncated)));
  CHECK(Rejected(stray, sizeof(stray)));
  CHECK(Rejected(invalidLead, sizeof(invalidLead)));
  CHECK(Rejected(badContinuation, sizeof(badContinuation)));
  // Entradas vazias ou sem buffer.
  CHECK(Rejected("", 1));
  CHECK(Rejected(nullptr, 0));
}

void TestDescriptionSanitizing() {
  // Controles (BEL, TAB, U+0085), invisíveis (U+200B, U+FEFF) e direção (U+202E)
  // viram espaço; espaços repetidos viram um; pontas aparadas.
  const char noisy[] = "  NVIDIA\x07 GeForce\xE2\x80\x8B\tRTX\xEF\xBB\xBF \xE2\x80\xAE" "3050\xC2\x85  ";
  CHECK(Sanitized(noisy, sizeof(noisy), u"NVIDIA GeForce RTX 3050"));
  // Só controles e invisíveis: nada sobra.
  const char empty[] = "\x01\x1F \xE2\x80\x8B\xEF\xBB\xBF\x7F\xC2\x9F";
  CHECK(Rejected(empty, sizeof(empty)));
  // NBSP (U+00A0) não é removido aqui (o app normaliza espaços de novo).
  const char nbsp[] = "A\xC2\xA0" "B";
  CHECK(Sanitized(nbsp, sizeof(nbsp), u"A\u00A0B"));

  // Conjunto removido, unidade a unidade (igual a DESCRIPTION_STRIP).
  CHECK(IsStrippedUnit(0x0000) && IsStrippedUnit(0x001F) && IsStrippedUnit(0x007F) && IsStrippedUnit(0x009F));
  CHECK(IsStrippedUnit(0x200B) && IsStrippedUnit(0x200F) && IsStrippedUnit(0x202A) && IsStrippedUnit(0x202E));
  CHECK(IsStrippedUnit(0x2060) && IsStrippedUnit(0x2069) && IsStrippedUnit(0xFEFF));
  CHECK(!IsStrippedUnit(0x0020) && !IsStrippedUnit(0x007E) && !IsStrippedUnit(0x00A0) && !IsStrippedUnit(0x200A));
  CHECK(!IsStrippedUnit(0x2010) && !IsStrippedUnit(0x2029) && !IsStrippedUnit(0x202F) && !IsStrippedUnit(0x206A));
}

void TestDescriptionTruncation() {
  // 200 caracteres ASCII: cortados em 128.
  static char longText[201];
  for (int i = 0; i < 200; ++i) longText[i] = static_cast<char>('a' + (i % 26));
  longText[200] = '\0';
  char16_t out[kMaxDescriptionUnits];
  std::size_t length = 0;
  CHECK(SanitizeDescription(reinterpret_cast<const std::uint8_t*>(longText), sizeof(longText), out, kMaxDescriptionUnits, length));
  CHECK(length == kMaxDescriptionUnits && out[0] == u'a' && out[127] == static_cast<char16_t>(u'a' + (127 % 26)));

  // 127 caracteres + U+1F600: o par não cabe inteiro e não é separado.
  static char boundary[127 + 4 + 1];
  for (int i = 0; i < 127; ++i) boundary[i] = 'A';
  std::memcpy(boundary + 127, "\xF0\x9F\x98\x80", 4);
  boundary[131] = '\0';
  CHECK(SanitizeDescription(reinterpret_cast<const std::uint8_t*>(boundary), sizeof(boundary), out, kMaxDescriptionUnits, length));
  CHECK(length == 127 && out[126] == u'A');

  // O corte não deixa espaço no fim.
  static char spaced[128 + 2 + 1];
  for (int i = 0; i < 127; ++i) spaced[i] = 'B';
  spaced[127] = ' ';
  spaced[128] = 'C';
  spaced[129] = 'D';
  spaced[130] = '\0';
  CHECK(SanitizeDescription(reinterpret_cast<const std::uint8_t*>(spaced), sizeof(spaced), out, kMaxDescriptionUnits, length));
  CHECK(length == 127 && out[126] == u'B');

  // UTF-8 inválido depois do ponto de corte ainda descarta a descrição.
  static char lateInvalid[200 + 2 + 1];
  for (int i = 0; i < 200; ++i) lateInvalid[i] = 'x';
  lateInvalid[200] = '\xC0';
  lateInvalid[201] = '\x80';
  lateInvalid[202] = '\0';
  CHECK(Rejected(lateInvalid, sizeof(lateInvalid)));
}

}  // namespace

int main() {
  TestUint64();
  TestLuid();
  TestMinimal();
  TestTypical();
  TestUnavailableFields();
  TestLimitsAndLuids();
  TestEscapes();
  TestInvalidDescriptions();
  TestSixteenAdapters();
  TestBufferLimits();
  TestKeyOrder();
  TestDescriptionDecoding();
  TestDescriptionSanitizing();
  TestDescriptionTruncation();
  std::printf("%d verificacoes, %d falhas\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
