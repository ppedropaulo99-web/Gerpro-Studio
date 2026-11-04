// DriverDescription: bytes do driver -> texto UTF-16 sanitizado, só para
// exibição. Independe do DXCore e do Win32 (testado com dados sintéticos).

#pragma once

#include <cstddef>
#include <cstdint>

namespace gerpro {

// Maior DriverDescription aceita, em bytes, incluindo o NUL final. Acima
// disso a descrição é descartada (null), sem ser lida.
constexpr std::size_t kMaxDescriptionBytes = 1024;

// Decodifica UTF-8 estrito (sem sequências longas demais, sem substitutos
// codificados, até U+10FFFF, sem sequência truncada) e sanitiza:
//
// 1. caracteres de controle e invisíveis (o mesmo conjunto de
//    DESCRIPTION_STRIP em dxcore-contract.ts) viram espaço;
// 2. espaços repetidos viram um, sem espaço no início ou no fim;
// 3. o texto é cortado em `capacity` unidades UTF-16 sem separar um par
//    substituto, e aparado de novo.
//
// `bytes` vai até o primeiro NUL ou até `length`. Devolve `false` (descrição
// null) se o texto não for UTF-8 válido, se não houver NUL dentro de
// `length`, ou se nada sobrar depois da sanitização.
bool SanitizeDescription(const std::uint8_t* bytes, std::size_t length, char16_t* out, std::size_t capacity, std::size_t& outLength);

// Se a unidade pertence ao conjunto removido pela sanitização.
bool IsStrippedUnit(char16_t unit);

}  // namespace gerpro
