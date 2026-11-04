# gerpro-dxcore-helper

Auxiliar nativo do Gerpro Studio (D54, D56): lista os adaptadores gráficos pelo
DXCore do Windows e responde no protocolo `gerpro.dxcore-adapters` v1
(`docs/04-hardware-advisor.md`, seção "Auxiliar DXCore").

**Situação (Etapa 6C.3B.2B):** compilado com MSVC v143 (14.44.35207) e Windows
SDK 10.0.26100.0, x64, reproduzível em dois builds limpos. Só os testes
sintéticos (`serializer_tests.exe`) foram executados; o auxiliar em si
**nunca foi executado** e não consultou nenhuma GPU. O app não executa o
auxiliar: `DXCORE_HELPER_SHA256` continua `null` e o `BundledHelperRunner`
recusa qualquer binário (`integrity-unknown`). Nenhum binário entra no
repositório (saídas em pastas ignoradas pelo git).

## Estrutura

| Arquivo | Papel | Inclui `<dxcore.h>` |
| --- | --- | --- |
| `src/main.cpp` | `wmain`: argumentos, saída em pipe, fluxo e códigos de saída | não |
| `src/dxcore_loader.h/.cpp` | proteções de carregamento; `dxcore.dll` só da System32; `DXCoreCreateAdapterFactory` por `GetProcAddress` | sim (só para conferir a assinatura) |
| `src/adapters.h/.cpp` | registro do protocolo (`AdapterRecord`) e enumeração `D3D11_GRAPHICS` | só o `.cpp` (com `<initguid.h>`) |
| `src/description.h/.cpp` | `DriverDescription`: UTF-8 estrito → UTF-16 sanitizado, corte em 128 | não |
| `src/json_writer.h/.cpp` | serialização estrita, buffer fixo de 64 KiB | não |
| `tests/serializer_tests.cpp` | testes com adaptadores simulados (serializador e descrição) | não |

Sem dependências de terceiros: só C++17, Win32, o SDK do Windows (headers do
DXCore e `wrl/client.h`) e o CRT estático do MSVC. Sem exceções (`/EHs-c-`),
sem RTTI, sem alocação dinâmica pelo auxiliar (buffers estáticos).

## Fluxo e códigos de saída

1. Linha de comando diferente de exatamente `--protocol 1` → **64**, antes de
   carregar qualquer coisa.
2. Saída padrão ausente ou que não seja pipe → **13** (o auxiliar nunca
   escreve em arquivo nem no console).
3. Proteções de carregamento (`SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)`,
   política de imagens, pontos de extensão, handles estritos) não
   estabelecidas → **10**, sem carregar a DLL. Código existente: o app trata
   como DXCore indisponível e volta para Electron + Registro.
4. `dxcore.dll` ausente da System32 ou sem `DXCoreCreateAdapterFactory` → **10**.
5. Fábrica não criada → **11**.
6. Lista não criada, mais de 16 adaptadores, `GetAdapter` com falha,
   adaptador inválido (`IsValid`) ou lista alterada durante a leitura
   (`IsStale`) → **12**.
7. Resposta montada inteira em memória; violação do protocolo ou acima de
   64 KiB → **13**, sem escrever nada.
8. Escrita com falha → **13** (o executor descarta a saída de qualquer código
   diferente de 0).
9. Sucesso → **0**, resposta completa e uma quebra de linha.

Iguais a `DXCORE_EXIT_CODES`; nenhum código novo. A saída de erro nunca é
usada.

## Propriedades

| Propriedade DXCore | Leitura | Campo |
| --- | --- | --- |
| `InstanceLuid` | `LUID`, tamanho exato 8 | `luid`: `HighPart` (com sinal) como 32 bits sem sinal, `HHHHHHHH:LLLLLLLL` maiúsculo |
| `HardwareID` | `DXCoreHardwareID`, tamanho exato 16 | `vendorId`, `deviceId`; `subSysID` e `revision` nunca copiados |
| `DriverDescription` | texto terminado em NUL, até 1.024 bytes | `description` (abaixo) |
| `IsHardware`, `IsIntegrated` | `bool`, tamanho exato 1, só 0 ou 1 | booleano |
| `DedicatedAdapterMemory`, `DedicatedSystemMemory`, `SharedSystemMemory` | `uint64_t`, tamanho exato 8 | texto decimal |

Cada leitura: `IsPropertySupported` → `GetPropertySize` igual ao tipo →
`GetProperty`. Qualquer passo que falhe deixa só aquele campo `null`.

**Descrição.** Aceita só UTF-8 válido (sem sequências longas demais, sem
substitutos codificados, até U+10FFFF); outra codificação → `null`.
Controles e invisíveis (o conjunto de `DESCRIPTION_STRIP`) viram espaço,
espaços repetidos viram um, pontas aparadas, corte em 128 unidades UTF-16 sem
separar par substituto. Vazia → `null`. A recusa de textos com cara de
caminho ou identificador continua no app.

## Serialização

Chaves na ordem de `DXCORE_WIRE_ADAPTER_KEYS`, sem espaços, uma quebra de
linha final; `null` literal para campo não lido (nunca chave ausente);
`version`, `vendorId` e `deviceId` em decimal canônico; memórias sempre entre
aspas. Descrição: ASCII imprimível direto, `"` e barra invertida escapadas,
todo o resto em `\uXXXX` maiúsculo (pares substitutos como dois escapes).
Saída 100% ASCII. Pior caso (16 adaptadores, tudo no máximo, descrições de
128 unidades fora do ASCII): bem abaixo de 64 KiB; o limite é conferido mesmo
assim.

Os textos esperados dos testes ficam em literais `R"golden(...)golden"`; o
teste `tests/main/dxcore-native-sources.test.ts` confere que o parser do app
aceita cada um, com os mesmos valores.

## Contratos do SDK (conferidos na Etapa 6C.3B.2B)

Conferidos por leitura de `um\dxcore.h` e `um\dxcore_interface.h` do Windows
SDK 10.0.26100.0 instalado, e pela compilação com `/W4 /WX` (sem avisos). O
código não declara nenhuma interface: tudo vem de `<dxcore.h>`. Nenhuma
correção no código foi necessária por causa dos headers.

| Item | Header | Situação |
| --- | --- | --- |
| `DXCoreCreateAdapterFactory` | `STDAPI DXCoreCreateAdapterFactory(REFIID riid, void** ppvFactory)` mais uma sobrecarga template `(T**)` inline; sob `#if (_WIN32_WINNT >= _WIN32_WINNT_WIN10)` | confirmado; o `static_cast` do `static_assert` escolhe a forma não template |
| `IDXCoreAdapterFactory::CreateAdapterList` | `(uint32_t numAttributes, const GUID* filterAttributes, REFIID, void**)` → `HRESULT` | confirmado |
| `IDXCoreAdapterList` | `GetAdapter(uint32_t, REFIID, void**)` → `HRESULT`; `GetAdapterCount()` → `uint32_t`; `IsStale()` → `bool` | confirmado |
| `IDXCoreAdapter` | `IsValid()` e `IsPropertySupported(DXCoreAdapterProperty)` → `bool`; `GetProperty(DXCoreAdapterProperty, size_t, void*)` e `GetPropertySize(DXCoreAdapterProperty, size_t*)` → `HRESULT` | confirmado |
| `DXCORE_ADAPTER_ATTRIBUTE_D3D11_GRAPHICS` | `DEFINE_GUID(..., 0x8c47866b, 0x7583, 0x450d, ...)` | confirmado: exige `<initguid.h>` numa unidade (`adapters.cpp`) |
| `DXCoreAdapterProperty` | `enum class : uint32_t`; `InstanceLuid` 0, `DriverDescription` 2, `HardwareID` 3, `DedicatedAdapterMemory` 7, `DedicatedSystemMemory` 8, `SharedSystemMemory` 9, `IsHardware` 11, `IsIntegrated` 12 | confirmado |
| `DXCoreHardwareID` | `uint32_t vendorID, deviceID, subSysID, revision` (16 bytes) | confirmado; o header recomenda `HardwareIDParts` "se disponível", que não é usado (traria `subVendorID`/`subSystemID`, que o protocolo não quer) |
| Tamanhos | o próprio header faz `static_assert(sizeof(bool) == 1)` | confirmado; os `static_assert` do código passaram |
| Tipo de cada propriedade (`LUID`, texto, `bool`, `uint64_t`) | **não declarado no header** (só os nomes do enum) | inalterado: o código confere em tempo de execução que `GetPropertySize` é exatamente o do tipo esperado; senão o campo fica `null` |
| Codificação de `DriverDescription` | **não documentada no header** | inalterado: só UTF-8 válido é aceito, o resto vira `null` |
| Semântica de `IsIntegrated` | sem comentário no header | inalterado: o app só usa como classificação, `null` = desconhecido |
| Exigências de versão | só a função de `dxcore.h` exige `_WIN32_WINNT >= WIN10`; `dxcore_interface.h` exige C++ (`#ifdef __cplusplus`) | atendidas por `/D_WIN32_WINNT=0x0A00`; disponibilidade em tempo de execução: `LoadLibraryExW`/`GetProcAddress` (código 10) e `IsPropertySupported` |
| `LUID.HighPart` | `LONG` (de `winnt.h`) | formatação já trata o sinal |

Não usados: `DriverVersion`, `KmdModelVersion`, `HardwareIDParts`,
`IsDetachable`, preempção, `AcgCompatible`, `IDXCoreAdapterFactory1`,
contagem/nomes de engines, `QueryState`/`SetState`, notificações. Nenhum
dispositivo gráfico é criado.

## Segurança

- `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` antes de qualquer
  carga; `LoadLibraryExW(L"dxcore.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32)`;
  `/DEPENDENTLOADFLAG:0x800` para as importações estáticas; CRT estático
  (`/MT`), sem `vcruntime` carregado da pasta do app. Importação estática
  permitida: só `KERNEL32.dll` (conferida no binário).
- Políticas do processo: imagens só locais e sem rótulo baixo, preferência
  pela System32; pontos de extensão desligados; handles estritos.
  **Não ativadas nesta versão:** `MicrosoftSignedOnly` e `ProhibitDynamicCode`.
- Sem shell, sem processos filhos (nenhuma API de criação de processo), sem
  rede, sem arquivos, sem Registro, sem COM ativado por `CoCreateInstance`,
  sem log, sem telemetria, sem elevação (`asInvoker`).
- Interfaces COM em `Microsoft::WRL::ComPtr`, liberadas antes de `FreeLibrary`.
- `SetErrorMode` sem caixas de diálogo; falha de memória ou exceção estrutural
  encerra o processo (o app trata como `crashed` e volta para o fallback).

## Job Object (pendente de decisão)

Plano: `docs/10-ativacao-dxcore.md`. Na Etapa 6C.6B.2 o launcher separado
(`native/helper-host`, `gerpro-helper-host.exe`) foi implementado e
compilado, mas **não foi executado nem conectado ao app**. Ele cria este
auxiliar suspenso, já dentro do job, com a política de processos filhos
apenas como defesa adicional. O texto abaixo registra a análise anterior.

Objetivo: impedir que o auxiliar (ou código injetado nele) crie processos
filhos, e garantir que nada sobreviva a ele.

- **Jobs aninhados:** desde o Windows 8 um processo que já está num job pode
  ser associado a um job novo e vazio, sem limites de interface, que vira
  filho do anterior.
- **Job herdado do executor:** o `child_process.spawn` do Node (libuv) já
  coloca os filhos num job global com `KILL_ON_JOB_CLOSE` e permissões de
  saída do job (`BREAKAWAY_OK`/`SILENT_BREAKAWAY_OK`), pelo que se conhece do
  código da libuv; a confirmar no Electron 45.
- **Problema:** com `SILENT_BREAKAWAY_OK` num job ancestral, não está
  confirmado se um processo criado pelo auxiliar sairia também do job
  aninhado criado por ele (a documentação de jobs aninhados não deixa claro, e
  não há como testar sem executar processos). `ACTIVE_PROCESS_LIMIT = 1` no
  job próprio pode, portanto, não bloquear filhos.
- **Supervisor do diagnóstico manual (D55):** inicia o Electron; o auxiliar
  seria neto dele, dentro dos mesmos jobs da libuv.
- `ProcessChildProcessPolicy` não pode ser aplicada pelo próprio processo
  depois de iniciado (só na criação, por atributo); o Node não oferece esse
  atributo.

**Decisão desta etapa:** o Job Object **não** foi implementado. Ativá-lo sem
garantia de efeito seria uma proteção silenciosamente ineficaz, e torná-lo
obrigatório exigiria um código de saída novo. Proposta compatível com o parser
para a 6C.3B.2, se aprovada: criar o job com `ACTIVE_PROCESS_LIMIT = 1`,
`KILL_ON_JOB_CLOSE` e `DIE_ON_UNHANDLED_EXCEPTION`, sem `BREAKAWAY_OK`; se a
associação falhar, sair com **12** (falha na enumeração, código já existente;
o app volta para o fallback). Antes, um teste nativo autorizado deve verificar
se a criação de processo é de fato bloqueada dentro do job aninhado sob o job
da libuv.

## Ambiente de build (Etapa 6C.3B.2A; instalado na 6C.3B.2B)

Instalação manual, feita pelo usuário; nenhum script do projeto instala nada.

**Instalado nesta máquina (6C.3B.2B):** Visual Studio Build Tools 2026
(`...\Microsoft Visual Studio\18\BuildTools`) com o componente MSVC v143
(VS 2022, x64/x86) e o Windows 11 SDK 10.0.26100 (headers em
`10.0.26100.0`). O Build Tools 2026 tem como padrão outro conjunto de
ferramentas (14.51, que aqui só tem `Auxiliary`, sem `cl.exe`); por isso o
ambiente tem de ser aberto pedindo o v143 explicitamente:

```
"%ProgramFiles(x86)%\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64 -vcvars_ver=14.44
```

O script recusa qualquer `VCToolsVersion` fora de 14.30 a 14.4x (v143) e
exige que `VCToolsInstallDir` seja a pasta dessa mesma versão. O aviso
"'vswhere.exe' não é reconhecido" do `vcvarsall.bat` é inofensivo (ele procura
o `vswhere` no PATH, que não é alterado).

O texto abaixo foi escrito antes da instalação, para o Build Tools 2022; vale
também para o 2026 com o v143.

**Fonte oficial:** instalador do Visual Studio Build Tools 2022
(`vs_BuildTools.exe`) na página de downloads do Visual Studio da Microsoft
(seção "Ferramentas para Visual Studio"). O pacote `winget`
`Microsoft.VisualStudio.2022.BuildTools` baixa o mesmo instalador.

**Componentes (individuais, sem a carga de trabalho completa):**

| Componente | Identificador no instalador |
| --- | --- |
| MSVC v143, ferramentas de build x64/x86 (mais recente) | `Microsoft.VisualStudio.Component.VC.Tools.x86.x64` |
| Windows 11 SDK 10.0.26100.x | `Microsoft.VisualStudio.Component.Windows11SDK.26100` (confirmar o nome exato na lista "Componentes individuais") |

As dependências obrigatórias (núcleo do Build Tools, núcleo do MSVC) são
adicionadas pelo próprio instalador. Não são necessários: IDE, CMake, ATL/MFC,
bibliotecas Spectre, Clang, ferramentas ARM64, .NET.

**Espaço em disco:** estimativa de 4 a 7 GB (MSVC cerca de 2 a 3 GB; SDK cerca
de 2 a 3 GB, com bibliotecas de várias arquiteturas), mais o cache do
instalador; o valor exato aparece no resumo do instalador antes de confirmar.
Livre nesta máquina: cerca de 275 GB.

**Privilégios:** a instalação pede elevação (UAC), porque grava em
`Program Files (x86)`. O build em si roda como usuário comum.

**Procedimento recomendado:**

1. Baixar `vs_BuildTools.exe` da página oficial e conferir a assinatura
   digital do arquivo (Propriedades → Assinaturas digitais → Microsoft
   Corporation).
2. Executar e, em "Componentes individuais", marcar só os dois componentes
   acima (ou, em linha de comando: `vs_BuildTools.exe --add
   Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add
   Microsoft.VisualStudio.Component.Windows11SDK.26100 --passive --norestart`).
3. Nada mais a configurar: o Build Tools não altera o PATH global; o
   ambiente vem só do atalho "x64 Native Tools
   Command Prompt for VS 2022" (`vcvars64.bat`), por sessão.

**Convivência com o MSYS2:** o MSYS2 não está no PATH global desta máquina
(só nas próprias sessões dele, como o Git Bash). O build deve ser feito no
prompt x64 do Visual Studio, e o script passa ao compilador um PATH só com
MSVC, SDK e System32. Nenhum dos dois altera o outro.

**Verificações depois de instalar** (no prompt x64 do Visual Studio):

1. `echo %VSCMD_ARG_TGT_ARCH% %VSCMD_ARG_HOST_ARCH%` → `x64 x64`.
2. `echo %VCToolsVersion%` → `14.4x.xxxxx`; `echo %WindowsSDKVersion%` →
   `10.0.26100.x\`.
3. `where cl` e `where link` → ambos em `...\BuildTools\VC\Tools\MSVC\<versão>\bin\Hostx64\x64\`
   (o primeiro resultado).
4. `dir "%WindowsSdkDir%Include\%WindowsSDKVersion%um\dxcore*.h"` →
   `dxcore.h` e `dxcore_interface.h`.
5. `node scripts/native/build-dxcore-helper.mjs --check-toolchain` → versões
   e "Nada foi compilado".

## Lista de conferência dos headers (6C.3B.2A)

Lista preparada antes da instalação. Todos os itens foram conferidos na
6C.3B.2B; o resultado está em "Contratos do SDK", acima.

| Item | O que conferir | Uso no código |
| --- | --- | --- |
| `DXCoreCreateAdapterFactory` | forma não template: `REFIID`, `void**`, retorno `HRESULT`, convenção `STDAPI`; exportada por `dxcore.dll` com esse nome | `CreateAdapterFactoryFn` e `static_assert` em `dxcore_loader.cpp`; `GetProcAddress` |
| `IDXCoreAdapterFactory::CreateAdapterList` | `(uint32_t numAttributes, const GUID* filterAttributes, REFIID, void**)` | `adapters.cpp` |
| `IDXCoreAdapterList` | `GetAdapterCount()` → `uint32_t`; `GetAdapter(uint32_t, REFIID, void**)`; `IsStale()` → `bool` | `adapters.cpp` |
| `IDXCoreAdapter` | `IsValid()`, `IsPropertySupported(DXCoreAdapterProperty)` → `bool`; `GetPropertySize(DXCoreAdapterProperty, size_t*)`; `GetProperty(DXCoreAdapterProperty, size_t, void*)` | `adapters.cpp` |
| `DXCORE_ADAPTER_ATTRIBUTE_D3D11_GRAPHICS` | declarado com `DEFINE_GUID` (exige `<initguid.h>` numa unidade) ou com outra forma | `adapters.cpp` |
| `DXCoreAdapterProperty` | nomes `InstanceLuid`, `DriverDescription`, `HardwareID`, `DedicatedAdapterMemory`, `DedicatedSystemMemory`, `SharedSystemMemory`, `IsHardware`, `IsIntegrated`; tipo do enum | `adapters.cpp` |
| `DXCoreHardwareID` | campos `vendorID`, `deviceID`, `subSysID`, `revision` (32 bits cada; 16 bytes) | `static_assert` e leitura |
| `InstanceLuid` | tipo `LUID` (`LowPart` `DWORD`, `HighPart` `LONG`) | formatação do LUID |
| `DriverDescription` | tipo (`char[]` terminado em NUL) e codificação documentada no comentário do header, se houver | `ReadDescription` |
| `IsHardware`, `IsIntegrated` | tipo `bool` (1 byte); texto do header sobre a semântica de "integrado" | `ReadBool` |
| Memórias | tipo `uint64_t` | `ReadMemory` |
| Exigências de versão | condições `#if` (`_WIN32_WINNT`, `NTDDI_VERSION`) que envolvem as declarações | opções `/D_WIN32_WINNT=0x0A00` |

## Build

Requisitos: MSVC v143 x64 (Build Tools 2022, ou 2026 com o componente v143) e
Windows SDK 10.0.26100.x, com `dxcore.h` e `dxcore_interface.h`. O script não
instala nada.

No ambiente x64 do v143 (prompt do Visual Studio, ou `vcvarsall.bat x64
-vcvars_ver=14.44` no Build Tools 2026), na raiz do projeto:

```
node scripts/native/build-dxcore-helper.mjs --check-toolchain
node scripts/native/build-dxcore-helper.mjs --confirm-native-build --reproducibility-check
```

- `--check-toolchain`: só confere o ambiente (versões, `cl.exe`, `link.exe`,
  `dxcore.h`, `dxcore_interface.h`) e sai; não compila, não cria nem apaga nada.
- Sem a confirmação, sai com código 2 sem fazer nada.
- Chama só o `cl.exe` do MSVC (caminho absoluto de `VCToolsInstallDir`), sem
  shell; compila o auxiliar e `serializer_tests.exe`; **não executa nenhum**.
- O compilador recebe um ambiente restrito: `PATH` só com a pasta do MSVC, a
  do SDK e a System32, além de `INCLUDE`, `LIB`, `LIBPATH`, `TEMP`/`TMP` e
  `SystemRoot`. O `link.exe` chamado pelo `cl.exe` nunca vem do MSYS2 (que tem
  um `link` próprio) nem de outra pasta do usuário.
- Pastas do MSVC e do SDK com junção ou link são recusadas; o script só apaga
  `build/x64` e `build/x64-repro` e só grava em pastas próprias que não sejam
  links ou junções.
- Confere o binário (`scripts/native/pe-inspect.ts`): x64, PE32+, console,
  executável, `DYNAMIC_BASE`, `HIGH_ENTROPY_VA`, `NX_COMPAT`, `GUARD_CF`
  instrumentado, `CET_COMPAT`, `DependentLoadFlags = 0x800`, só `KERNEL32.dll`
  importada, manifesto embutido com `level='asInvoker'` e `uiAccess='false'`,
  tamanho entre 1 KiB e 8 MiB, sem a pasta do projeto ou do usuário embutida.
  Qualquer falha apaga o binário gerado.
- `--reproducibility-check`: segundo build em pasta limpa; hashes diferentes
  recusam o resultado.
- Saídas (fora do git): `resources/helpers/win32-x64/gerpro-dxcore-helper.exe`
  e `native/dxcore-helper/build/` (objetos, testes e `build-manifest.json`).
- Manifesto sanitizado: versões do MSVC e do SDK, opções, hash de cada fonte,
  tamanho e hash do binário, propriedades do PE. Sem caminhos absolutos,
  usuário, máquina ou data.
- **O hash não é aplicado ao app.** `DXCORE_HELPER_SHA256` só muda numa
  alteração de código separada, revisada, com o manifesto ao lado.

### Reprodutibilidade

Mesmo commit, mesma versão do MSVC (`VCToolsVersion`) e do SDK, mesmas opções
→ mesmo binário: `/Brepro` (compilador e linker) troca a data do cabeçalho
por um hash do conteúdo; sem informação de depuração (`/DEBUG:NONE`), nenhum
caminho de PDB entra no binário; os fontes são compilados por caminho
relativo. Atualizar o MSVC ou o SDK muda o hash e exige novo manifesto.
Limitações: a reprodutibilidade entre máquinas diferentes ainda não foi
verificada; o binário não é assinado (assinatura Authenticode pendente).

### Primeiro build (Etapa 6C.3B.2B)

- MSVC 14.44.35207 (v143), Windows SDK 10.0.26100.0, x64; sem avisos com
  `/W4 /WX`; nenhuma proteção desligada.
- Auxiliar: 115.712 bytes, SHA-256
  `d2e3aabcbec2a462af1c237b7f8c4d35d0b0b698f18a67748a2efc899d84b13b`
  (o hash **não** foi aplicado ao app). `serializer_tests.exe`: 172.032 bytes.
- Dois builds limpos: auxiliar e testes idênticos byte a byte.
- `pe-inspect.ts` e, de forma independente, `dumpbin /headers /imports
  /loadconfig /dependents` concordam: `0x8664`, PE32+, console,
  DllCharacteristics `0xC160` (alta entropia, base dinâmica, NX, CFG,
  Terminal Server), Guard Flags `0x10017500` (CF instrumentado, tabela FID),
  Dependent Load Flag `0x800`, CET compatível, só `KERNEL32.dll`, manifesto
  `asInvoker`/`uiAccess='false'`, sem entrada de PDB e sem caminhos
  embutidos.
- As importações de `KERNEL32.dll` incluem, além das funções do auxiliar
  (`GetStdHandle`, `GetFileType`, `WriteFile`, `SetErrorMode`,
  `SetProcessMitigationPolicy`, `SetDefaultDllDirectories`, `LoadLibraryExW`,
  `GetProcAddress`, `FreeLibrary`), as do CRT estático (`/MT`), como
  `CreateFileW`, `FindFirstFileExW`, `VirtualProtect` e `TerminateProcess`. O
  código do auxiliar não as chama; vêm da inicialização e do tratamento de
  falhas do CRT.
- `serializer_tests.exe` executado (só ele): 98 verificações, 0 falhas; pior
  caso com 16 adaptadores: 16.655 bytes. As respostas comparadas byte a byte
  são as mesmas que o teste do app aceita com o parser.
- Correções feitas para compilar (só nos testes e na ligação deles):
  1. o literal bruto da resposta com escapes saiu de dentro do `CHECK`: o
     pré-processador tradicional do MSVC não reconhece literal bruto com `\"`
     dentro de argumento de macro;
  2. `ClearRecord` passou a `inline` em `adapters.h`: os testes não ligam
     `adapters.cpp` (que depende do DXCore).

### Distribuição

- Desenvolvimento: `resources/helpers/win32-x64/` na raiz do projeto
  (`resourcesRoot` de desenvolvimento, a definir no Main na integração).
- Empacotado: `process.resourcesPath\helpers\win32-x64\`, fora do asar (um
  executável dentro do asar não pode ser executado). O app ainda não tem
  empacotador; nada do empacotamento foi alterado.
- ARM64: fora do escopo; o executor procura `win32-arm64`, não encontra e
  volta para o fallback.
