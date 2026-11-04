# Gerpro Hardware Advisor

Avalia os recursos do computador para recomendar agentes e modelos
compatíveis.

| Parte | Status |
|---|---|
| Contrato do perfil, validação e estados | Implementado |
| Consentimento com escopo, revogação e exclusão de dados | Implementado (gravado em `hardware.json`) |
| Motor de recomendações | Implementado (regras puras, testadas) |
| Perfis de hardware | **Simulado:** cinco cenários fictícios |
| Biblioteca de modelos usada nas recomendações | **Simulado** |
| Detecção real de hardware | **Planejado:** o detector real sempre responde "indisponível" |
| Envio do perfil ao Gerpro Web | **Planejado:** a validação impede concedê-lo |

Os passos técnicos para implementar o detector real estão em
[`src/main/hardware/README.md`](../src/main/hardware/README.md).

## Perfil de hardware (`HardwareProfile`)

| Campo | Conteúdo | Desconhecido |
|---|---|---|
| `cpu` | modelo, arquitetura, núcleos físicos e lógicos | cada atributo pode ser `null`; a seção é `null` só sem nenhum atributo conhecido |
| `memory` | total e disponível (GB) | idem, por atributo |
| `gpus` | fabricante, modelo, VRAM, memória compartilhada | `null` = não identificável; `[]` = nenhuma GPU |
| `storage` | livre e total (GB) | idem, por atributo |
| `os` | plataforma, versão e arquitetura | idem, por atributo |
| `acceleration` | `avx2`, `avx512`, `neon`, `cuda`, `rocm`, `metal`, `vulkan`, `directml` | `null` = não identificável; `[]` = nenhuma |
| `provenance` | `source` (`demo` \| `local-detector`), `detectorId`, `collectedAt`, `confidence` (`high` \| `medium` \| `low`), `quality` | obrigatório |

O perfil não aceita identificadores do usuário nem números de série: campos
extras são rejeitados por `validateHardwareProfile`. O Main valida todo perfil
devolvido por um detector antes de gravá-lo. Um perfil inválido vira estado de
erro, nunca dado gravado.

### Qualidade por atributo (`provenance.quality`)

Cada atributo diz de onde veio: `detected` (lido do sistema), `estimated`
(deduzido), `unavailable` (não obtido) ou `simulated` (demonstração).

- `quality.fields`: um valor para cada atributo de `PROFILE_FIELDS`
  (`cpu.model`, `cpu.physicalCores`, `memory.totalGb`, `gpus`, `acceleration`…).
  Em `gpus` e `acceleration`, qualifica a lista: `[]` detectado significa
  "verificado e inexistente".
- `quality.gpus`: uma entrada por GPU, na ordem de `gpus`, com `vendor`,
  `model`, `vramGb` e `sharedMemory`; `null` quando `gpus` é `null`.

A validação exige coerência:

- valor ausente (`null`, ou `vendor: 'unknown'`) ⇔ `unavailable`. Nada
  ausente é dado como detectado, e nada presente como indisponível;
- perfil `demo` só tem `simulated` ou `unavailable`; perfil `local-detector`
  nunca tem `simulated`.

`uniformQuality(perfil, qualidade)` monta a qualidade a partir dos valores
(usada pelo detector demonstrativo e pela migração).

### Perfis parcialmente detectados (formato 3)

Todo atributo de `cpu`, `memory`, `storage` e `os` aceita `null`: um
atributo não identificado não descarta os demais da seção. Regras:

- o atributo continua obrigatório como chave; o desconhecido é `null`
  explícito, com qualidade `unavailable`;
- uma seção sem nenhum atributo conhecido deve ser `null` (forma única para
  "nada");
- regras entre atributos (disponível ≤ total, livre ≤ total, lógicos ≥
  físicos) só valem quando os dois são conhecidos;
- nenhum cálculo usa um atributo `null`. RAM total desconhecida deixa a
  recomendação e a compatibilidade indeterminadas; RAM livre desconhecida
  vira ressalva (`unknown`); espaço livre desconhecido não gera bloqueio de
  disco.

O formato 3 só amplia o 2, e `migrateHardwareV2` passa os dados sem
alteração. A versão muda para proteger o app anterior: um app v2 recusaria
um perfil parcial como inválido e o substituiria pelos padrões, perdendo o
consentimento. Com a versão nova, ele trata o arquivo como "mais novo" e não
grava. A migração copia o original (`hardware.v2-<data>.json`) e regrava o
arquivo na abertura, como na migração da v1.

### GPUs parcialmente identificadas (formato 4)

`gpus[].model` e `gpus[].sharedMemory` aceitam `null`:

- `model: null`: o nome do adaptador não foi informado;
- `sharedMemory: null`: não foi comprovado se a GPU tem memória própria
  (dedicada) ou usa a do sistema (integrada). O fabricante não basta: há
  GPUs Intel dedicadas (Arc) e AMD integradas (APUs);
- `vramGb` é a memória dedicada informada pelo driver. Numa integrada pode
  ser só a reserva do firmware, por isso só vale como VRAM para inferência
  quando `sharedMemory === false`;
- uma GPU com ao menos um atributo conhecido continua na lista; sem nenhum
  (`vendor: 'unknown'` e o resto `null`) é recusada.

Consumidores: recomendações e compatibilidade só usam a VRAM de GPUs com
`sharedMemory === false` e não somam a VRAM de GPUs diferentes. Com a
classificação desconhecida, a recomendação traz uma ressalva (`unknown`) e a
compatibilidade usa a posição `unknown-gpu-memory` (estimativa só da RAM;
"não caber na RAM" fica "não verificado", não "não recomendado"). VRAM
desconhecida nunca vira zero.

O formato 4 só amplia o 3; `migrateHardwareV3` passa os dados sem alteração,
com cópia do original (`hardware.v3-<data>.json`) e o mesmo motivo para mudar
a versão: um app v3 trata o arquivo v4 como "mais novo" e não grava.

### Sondagem de GPU e VRAM (Windows, ainda não conectada)

`src/main/hardware/local/probes/gpu.ts`, com dependências injetadas e sem
uso pelo app nesta etapa:

- adaptadores: `app.getGPUInfo('basic')` (recebido do Main, com prazo e
  cancelamento). Fabricante pelo identificador PCI (`0x10DE` NVIDIA, `0x1002`
  AMD, `0x8086` Intel; outros, `other`), nome por `deviceString`. O
  renderizador por software (Microsoft Basic Render Driver) não é GPU: se for
  o único adaptador, `gpus` é `[]` estimado;
- VRAM: `HardwareInformation.qwMemorySize` (REG_QWORD, 64 bits) na classe de
  adaptadores de vídeo do Registro, por duas consultas fixas do catálogo
  (`src/main/hardware/local/commands.ts`) executadas pelo `CommandRunner`.
  Tipo, formato hexadecimal e faixa (16 MiB a 1 TiB) são conferidos. Não usa
  `Win32_VideoController.AdapterRAM` nem `nvidia-smi`;
- associação: a VRAM de uma subchave só vai para o adaptador cujo par PCI
  fabricante/dispositivo aparece no `MatchingDeviceId` dessa mesma subchave,
  e só quando o par é único dos dois lados. GPUs idênticas, subchaves
  repetidas ou saída incoerente deixam a VRAM `unavailable`, mantendo a
  identificação. Nunca por posição;
- classificação: sempre `null` nesta etapa, por falta de fonte que a comprove;
- os identificadores PCI e as subchaves ficam só em memória; nada é gravado
  nem registrado em log.

### Auxiliar DXCore (protocolo 1; parser e regras prontos, ainda não conectados)

Decisão D54. Contrato em `src/main/hardware/local/dxcore-contract.ts` (tipos e
constantes). Parser e regras em TypeScript (Etapa 6C.2), em
`src/main/hardware/local/dxcore/`, testados só com dados simulados:

- `parser.ts`: `parseDxcoreResponse` (resposta → adaptadores validados ou um
  motivo), `sanitizeDescription`, `parseUint64` e `interpretHelperResult`
  (resultado do executor do auxiliar → situação da fonte; recusa de
  identidade ou integridade vira `helper-rejected`);
- `rules.ts`: `classifyMemory`, `resolveVram`, `vramAgrees` (tolerância
  `VRAM_AGREEMENT`, provisória) e a conversão para GB só na apresentação;
- `selection.ts`: `validateDxcoreList`, composição por multiconjunto
  (`sameComposition`, `electronPairsFrom`) e `selectGpuList`, que escolhe a
  fonte da lista uma vez por coleta.

O executável ainda não existe, não está no catálogo, e nem o detector nem o
serviço usam esses módulos; `sharedMemory` continua `null` no app.

> **Revisão (Etapas 6C.1.1 e 6C.1.2): sem associação por LUID.** Verificação
> real única, só com `app.getGPUInfo('basic')` (Electron 45.0.0, Windows 11
> x64, 3 adaptadores: NVIDIA, Intel e o renderizador por software da
> Microsoft): **nenhum adaptador tem a propriedade `luid`**. A associação
> DXCore ↔ Electron foi descartada. O DXCore passa a ser a fonte principal da
> lista de GPUs; o Electron fica como alternativa e o Registro como
> complemento de VRAM.

**Execução.** Executável local de caminho fixo, chamado por um executor
dedicado (`BundledHelperRunner`, D56; ver "Executor do auxiliar empacotado")
sem shell e com os argumentos fixos `--protocol 1` (outra linha de comando:
código 64, sem saída). Prazo 3 s, saída padrão até 64 KiB; o executor encerra
o processo ao estourar o prazo, no cancelamento ou acima do limite.

**Resposta (só com código 0).** Um objeto JSON, ASCII, sem BOM, com quebra de
linha final opcional:

```json
{
  "protocol": "gerpro.dxcore-adapters",
  "version": 1,
  "adapters": [
    {
      "luid": "00000000:0000ABCD",
      "vendorId": 4318,
      "deviceId": 9637,
      "description": "NVIDIA GeForce RTX 3050 Laptop GPU",
      "isHardware": true,
      "isIntegrated": false,
      "dedicatedAdapterMemory": "4148166656",
      "dedicatedSystemMemory": "0",
      "sharedSystemMemory": "8530190336"
    }
  ]
}
```

| Campo | Tipo | Origem DXCore | Regra |
|---|---|---|---|
| `protocol` | string | — | exatamente `gerpro.dxcore-adapters` |
| `version` | inteiro | — | exatamente `1`; outra versão recusa a resposta |
| `adapters` | lista | adaptadores `D3D11_GRAPHICS` | 0 a 16 itens; a ordem não tem significado |
| `luid` | string ou `null` | `InstanceLuid` | `HHHHHHHH:LLLLLLLL` (hexadecimal maiúsculo); `00000000:00000000` não identifica adaptador. Só confere que a lista não repete adaptadores |
| `vendorId`, `deviceId` | inteiro ou `null` | `HardwareID` | 0 a `0xFFFFFFFF` (32 bits: Qualcomm usa `0x4D4F4351`) |
| `description` | string ou `null` | `DriverDescription` | nome comercial, só exibição; até 128 unidades UTF-16 depois de decodificar; fora do ASCII em escapes `\uXXXX` |
| `isHardware` | booleano ou `null` | `IsHardware` | — |
| `isIntegrated` | booleano ou `null` | `IsIntegrated` | — |
| `dedicatedAdapterMemory` | string decimal ou `null` | `DedicatedAdapterMemory` | bytes, 0 a 2^64−1 |
| `dedicatedSystemMemory`, `sharedSystemMemory` | string decimal ou `null` | idem | bytes; nunca usados como VRAM |

- Todas as chaves são obrigatórias; `null` = propriedade não suportada pelo
  driver ou não lida. Chave ausente, chave desconhecida ou tipo errado
  invalidam a resposta inteira.
- Inteiros de 64 bits só em decimal (`^(0|[1-9][0-9]{0,19})$`, conferido com
  2^64−1) e lidos como `bigint`. Números JSON só para valores de 32 bits.
- `description` acima de 128 unidades invalida a resposta (o auxiliar corta
  antes). Depois de validada, é sanitizada: caracteres de controle, de
  formatação invisível e de direção de texto removidos, espaços normalizados;
  vira `null` se ficar vazia ou se parecer caminho (`\`, `/` inicial, `C:/`),
  identificador de dispositivo (`VEN_`, `DEV_`, `SUBSYS_`, `PCI\`), GUID ou
  sequência hexadecimal de 12 dígitos ou mais. Nunca serve para associar.
- Não constam versão do driver, subsistema, revisão nem caminhos.
- Versão: o campo `description` entrou ainda na versão 1, porque nenhum
  auxiliar foi compilado ou distribuído. Depois da primeira distribuição,
  qualquer mudança de campo exige nova versão.
- Saída acima de 64 KiB, vazia, não ASCII, com espaços antes ou depois do
  objeto (além de uma quebra de linha final), JSON inválido, protocolo ou
  versão diferentes, campo ausente, desconhecido ou repetido no mesmo objeto,
  tipo errado, LUID, identificador, inteiro ou descrição fora do formato e
  mais de 16 adaptadores: resposta inteira recusada (`invalid-output`, com o
  motivo de `DxcoreResponseError`). Nenhum dado parcial é aproveitado.
  Protocolo e versão são conferidos antes do conjunto de chaves: uma versão
  futura com campos novos é `unsupported-version`.
- Números JSON (`version`, `vendorId`, `deviceId`) só na forma canônica:
  inteiro decimal sem sinal, fração, expoente ou zero à esquerda (Etapa
  6C.2.1). `-0`, `1.0`, `4.318e3` e `4318.0000000000000001` passariam pelo
  `JSON.parse` como inteiros válidos (o último arredondado); agora recusam a
  resposta (`invalid-type`). A conferência é a última, para não mudar o
  motivo das demais recusas. Chaves escritas com escape (`"\u006cuid"`) são
  a mesma chave, inclusive para a detecção de repetição; a leitura do texto
  é iterativa, então aninhamento profundo dentro de 64 KiB recusa sem
  esgotar a pilha.

**Códigos de saída.** 0 resposta; 10 `dxcore.dll` ausente da pasta do sistema
ou sem `DXCoreCreateAdapterFactory`; 11 falha ao criar a fábrica; 12 falha ao
listar adaptadores; 13 falha ao escrever; 64 uso incorreto. Só o código 0
escreve na saída padrão. Qualquer outro código (inclusive falha do processo)
é `crashed`.

**Fonte da lista de GPUs.** Decidida uma vez por coleta, para a lista
inteira; as listas nunca se misturam.

1. **DXCore** (fonte principal), só se todas as condições valerem: fonte
   `ok`; todo adaptador com `isHardware` definido; ao menos um com
   `isHardware === true`; todo adaptador de hardware com `vendorId`,
   `deviceId` e LUID não nulo; nenhum LUID repetido; e, se o Electron também
   respondeu, a **mesma composição**: a quantidade de cada par
   fabricante/dispositivo entre os adaptadores de hardware do DXCore é igual à
   dos adaptadores do Electron, sem o renderizador por software. A composição
   só confere a lista inteira; não leva atributo de um adaptador a outro.
   Cada GPU vem de um registro de adaptador do DXCore, com todos os seus
   atributos tirados desse mesmo registro: fabricante pelo `vendorId`, nome
   pela `description` sanitizada (sem ela, `model: null`), classificação e
   VRAM. Adaptadores com `isHardware === false` (software ou remotos) ficam
   fora, como o renderizador por software hoje.
2. **Electron** (alternativa), em qualquer outro caso, com o motivo em
   `DxcoreListRejection` (`source-unavailable`, `hardware-flag-unknown`,
   `no-hardware-adapters`, `hardware-id-unknown`, `luid-invalid`,
   `luid-duplicate`, `lists-disagree`): exatamente a lista e a VRAM de hoje
   (Registro pelo par PCI único, D51), com `sharedMemory: null`. Uma falha do
   DXCore nunca remove informação que a coleta atual já obtém.

Sem associação por posição, nome ou fabricante. GPUs idênticas (mesmo par)
não precisam ser distinguidas: cada uma é um registro próprio do DXCore e
leva os próprios atributos.

**Semântica de `sharedMemory`.** Classificação operacional da memória
principal da GPU para as recomendações do Studio: `true` = a memória que a GPU
usa é a RAM do sistema (inclusive a reserva do firmware numa integrada);
`false` = a GPU tem memória própria, que pode ser contada como VRAM. O uso
complementar da RAM por uma dedicada não a torna compartilhada. `IsIntegrated`
indica como o adaptador está integrado ao sistema, não descreve todos os
detalhes físicos da memória; por isso só é aceito junto com as condições
abaixo, e o lado que conta VRAM (`false`) exige mais evidência:

| GPU da lista do DXCore | `sharedMemory` |
|---|---|
| `isIntegrated === true` | `true` (a memória "dedicada" de uma APU é reserva da RAM) |
| `isIntegrated === false` e `dedicatedAdapterMemory` entre 16 MiB e 1 TiB | `false` |
| `isIntegrated === false` e `dedicatedAdapterMemory` `null` | `null` (`dedicated-memory-unknown`) |
| `isIntegrated === false` e `dedicatedAdapterMemory` fora da faixa (inclusive 0) | `null` (`dedicated-memory-conflict`) |
| `isIntegrated` `null` | `null` (`integrated-unknown`) |
| lista do Electron | `null` (`dxcore-not-used`) |

**VRAM (política aprovada na Etapa 6C.1.1; ainda não implementada).** Nunca
soma GPUs diferentes; nunca usa `sharedSystemMemory` nem
`dedicatedSystemMemory` como VRAM dedicada; nunca usa fabricante ou nome.
Comparação em `bigint`; "concordam" = diferença de até 5% do maior valor, com
mínimo de 64 MiB (tolerância **provisória**, a confirmar com medição real).

| Lista do DXCore, GPU classificada `false` | `vramGb` |
|---|---|
| Registro associado (par único na lista do DXCore **e** no Registro) e concordante | Registro (`registry-confirmed`) |
| Registro associado e divergente | `null` (`sources-diverge`) |
| Registro sem associação inequívoca (inclusive GPUs idênticas) ou indisponível | memória dedicada do próprio adaptador (`dxcore`) |

- GPU da lista do DXCore classificada `true` ou não classificada: `vramGb:
  null` (`not-dedicated`); a reserva de uma integrada não é VRAM (aprovado
  na 6C.2). Na lista do Electron, a integrada continua podendo exibir o
  valor do Registro, que os consumidores já ignoram.
- GPUs idênticas: o Registro não é associado a nenhuma delas (D51); cada uma
  usa a memória do próprio registro do DXCore. Valores contraditórios entre
  fontes nunca são combinados.
- Lista do Electron: regra atual (`registry`, par PCI único).
- Rastreio do Registro por GPU (`registryFor`, corrigido na 6C.5A): `match`;
  `not-reported` (a subchave associada não tem `qwMemorySize`, comum em
  integradas); `invalid-value` (o valor existe, mas tipo, formato, repetição
  ou faixa são inválidos); `no-match`; `ambiguous`; `registry-unavailable`
  (inclusive quando nenhuma subchave tem o valor, porque aí o `reg query`
  termina com erro). Antes da correção, `not-reported` aparecia como
  `invalid-value` (visto na 6C.4A). Todos os casos sem `match` levam à mesma
  decisão de VRAM; só o motivo muda.

**Segurança do auxiliar.** Sem shell, rede, privilégios administrativos,
escrita de arquivos, compilação dinâmica nem argumentos variáveis.
`dxcore.dll` carregada só da pasta do sistema
(`LoadLibraryExW(..., LOAD_LIBRARY_SEARCH_SYSTEM32)`), com
`SetDefaultDllDirectories` restrito antes de qualquer outra carga; só
enumeração de adaptadores (nenhum dispositivo gráfico criado). Resposta
montada com tamanho limitado. O caminho é resolvido pelo Main (pasta de
recursos do app empacotado), nunca recebido do Renderer; identidade,
integridade e execução seguem a seção seguinte (D56); empacotamento e
assinatura ficam para quando o empacotador for definido.

**Privacidade.** LUID e identificadores PCI ficam só em memória durante a
coleta; não entram no perfil, em diagnósticos, logs ou arquivos. A saída do
auxiliar nunca é registrada; diagnósticos mostram só a situação da fonte
(`DxcoreSourceStatus`), a fonte da lista (`GpuListSource`) e os motivos
enumerados.

### Executor do auxiliar empacotado (D56; bloqueado até haver binário)

`src/main/hardware/local/bundled-helper.ts` (Etapa 6C.2.1), testado só com
arquivos e processos simulados. Nenhum módulo do app o executa: o parser só
importa o tipo do resultado, e nem o detector, nem o serviço, nem IPC,
Preload ou Renderer o citam (testes estáticos).

**Executor dedicado, não uma categoria do `CommandRunner`.** O
`CommandRunner` só executa programas da pasta do sistema
(`powershell`, `reg`), escolhidos por um catálogo; incluir um caminho
dentro do app criaria a primeira exceção à regra "só pasta do sistema" no
mesmo código que roda os comandos do PowerShell, e a validação de
identidade e integridade (que o catálogo não tem) ficaria misturada com a
dele. O executor dedicado serve um único auxiliar, sem catálogo nem
identificador de entrada: quem chama passa só um `AbortSignal` (qualquer
outro valor é ignorado). Os dois compartilham só a supervisão do processo
(`superviseProcess`, extraída do `CommandRunner` sem mudar o comportamento:
os testes do `CommandRunner` passam sem alteração), e `child_process`
continua importado só em `command-runner.ts`.

**Caminho.** `<recursos>\helpers\win32-<arquitetura>\gerpro-dxcore-helper.exe`,
com nome, subpasta e argumentos fixos no código (`DXCORE_HELPER`,
congelado). Só `x64` e `arm64`; outras arquiteturas: `unsupported-arch`.
A raiz de recursos é definida pelo Main (empacotado: `process.resourcesPath`;
desenvolvimento: a pasta de recursos do projeto, a definir na 6C.3), nunca
pelo Renderer, por IPC ou por texto de modelo. Raiz aceita: caminho local
absoluto com letra de unidade, já normalizado, sem `.`/`..`, sem rede
(`\\servidor`), dispositivo (`\\?\`, `\\.\`), fluxo alternativo (`:`),
caracteres proibidos em nomes nem mais de 240 caracteres; o caminho montado
tem de continuar dentro dela. Sem `PATH`: o executável nunca é procurado.

**Identidade e integridade (antes de executar, nesta ordem).**

1. `lstat` do arquivo: ausente → `unavailable/not-found`; sem permissão →
   `unavailable/permission-denied`; link simbólico → `symlink`; não arquivo
   comum → `not-regular-file`; tamanho fora de 1 KiB–8 MiB →
   `size-invalid`; outro erro → `io-error`.
2. Caminho real (`realpath`, que resolve links e junções em todas as pastas)
   igual ao montado, salvo maiúsculas → senão `redirected`. Uma raiz com nome
   curto 8.3 ou unidade `subst` também cai aqui (recusa segura).
3. Conteúdo lido inteiro; tamanho diferente do `lstat` → `integrity-changed`.
4. SHA-256 igual ao valor esperado da arquitetura, **embutido no código do
   app** (`DXCORE_HELPER_SHA256`), nunca num arquivo ao lado do executável.
   Hoje os dois valores são `null`: sem binário, o auxiliar é sempre recusado
   (`integrity-unknown`) e nenhum processo é iniciado.
5. Depois de uma execução com código 0, os passos 1–4 são repetidos e a
   identidade (dispositivo, inode, tamanho, data, hash) comparada: qualquer
   diferença descarta a saída (`integrity-changed`).

Hash fora do formato (64 dígitos hexadecimais minúsculos) é erro de
programação ao criar o executor, nunca ao executar.

**Execução.** `superviseProcess` com o caminho verificado, `--protocol 1`,
`shell: false`, `windowsVerbatimArguments: false`, janela oculta, entrada
fechada; diretório de trabalho e ambiente mínimos da pasta do sistema
(`SystemRoot`, `windir`, `PATH` = System32; nada do ambiente do app ou do
usuário). Prazo 3 s (provisório), saída padrão até 64 KiB, saída de erro até
4 KiB (só contada, nunca guardada). Prazo, cancelamento ou excesso de saída
encerram o processo; se ele não confirmar o encerramento em 2 s, o resultado
volta mesmo assim, com `processExited: false`. Uma execução por vez: as
demais esperam (e podem ser canceladas enquanto esperam, sem iniciar nada; a
seguinte continua esperando a que está em curso). O executor nunca lança
exceção. Cada resultado traz `process` (ver "Encerramento do processo"
abaixo); depois de um encerramento não confirmado, nenhuma execução nova
começa (`rejected`/`previous-unconfirmed`) até o processo anterior terminar
de fato.

#### Encerramento do processo: garantias e limites (Etapa 6C.5C)

`superviseProcess` informa só o que observou (`ProcessTermination`), e o
executor repassa isso em `HelperRunResult.process`:

| `process` | Significado | `processExited` |
| --- | --- | --- |
| `not-started` | Nenhum processo (recusa, indisponível, cancelado antes, falha ao iniciar) | `true` |
| `exited` | Terminou sozinho (evento `close`) | `true` |
| `stopped` | Encerramento pedido (prazo, cancelamento, excesso de saída) e `close` recebido dentro de 2 s | `true` |
| `exit-unconfirmed` | Encerramento pedido, sem `close` em 2 s | `false` |
| `kill-failed` | O pedido de encerramento lançou erro e o `close` não chegou em 2 s | `false` |
| `unknown` | O executor não sabe (erro inesperado; ou simulação que não informa) | — |

O que o supervisor **garante**:
- o resultado volta em no máximo prazo + 2 s, mesmo que o processo não termine;
- o fim da tolerância nunca é tratado como encerramento: só o `close` confirma;
- um `close` tardio não altera um resultado já devolvido, mas libera o executor;
- a saída de um processo interrompido nunca é usada (só `success` com código 0 é lida);
- no executor do auxiliar, nunca há dois processos dele ao mesmo tempo, nem um
  novo enquanto o anterior pode estar vivo.

O que ele **não garante** (sem Job Object):
- que um processo `exit-unconfirmed`/`kill-failed` termine: ele pode ficar
  órfão, rodando com os privilégios do usuário, até sair sozinho ou até o
  Windows encerrá-lo; o app não o encerra ao sair;
- que processos criados pelo processo iniciado sejam encerrados (`kill` só
  atinge o processo direto; o auxiliar não cria processos, por revisão do
  código, não por imposição do sistema);
- limite de memória, CPU ou tempo do lado do sistema operacional.

Diagnóstico: o detector registra em `gpuSource.helperProcess` o valor acima
e em `gpuSource.helperStop` o motivo da interrupção (`helper-timeout`,
`gpu-budget` ou `cancelled`). O app não declara isolamento de processos.
Encerrar a árvore inteira, impedir processos filhos, garantir o encerramento
quando o app sai e limitar recursos exigem um Job Object
(`KILL_ON_JOB_CLOSE`, `ACTIVE_PROCESS_LIMIT`), com código nativo, numa etapa
própria. O `CommandRunner` (consultas do PowerShell e do Registro) usa o
mesmo supervisor e tem as mesmas limitações, e ainda não bloqueia uma
consulta nova depois de um encerramento não confirmado (risco aberto, fora
do escopo da 6C.5C).

| Situação | Resultado do executor | Situação da fonte |
| --- | --- | --- |
| Código 0 e arquivo inalterado | `success` | `ok` ou `invalid-output` (parser) |
| Arquivo ausente | `unavailable/not-found` | `helper-unavailable` |
| Sem permissão (consultar, ler ou iniciar) | `unavailable/permission-denied` | `helper-unavailable` |
| Raiz, link, junção, tipo, tamanho, hash, troca, erro de leitura | `rejected/<motivo>` | `helper-rejected` |
| Prazo | `timeout` | `timeout` |
| Cancelamento | `cancelled` | `cancelled` |
| Saída acima do limite | `failed/output-limit` | `output-limit` |
| Códigos 10, 11, 12, 13, 64 | `failed/exit-code` | situação do protocolo |
| Outro código (inclusive negativo ou de exceção do Windows) | `failed/exit-code` | `crashed` |

Em todos os casos diferentes de `ok`, a seleção devolve o resultado atual
(Electron + Registro), o mesmo objeto, sem alteração. O resultado do executor
só tem códigos: nunca o caminho, a mensagem do sistema, a saída de erro ou a
saída padrão recusada.

**Riscos que não são eliminados nesta etapa** (D56):

- **TOCTOU.** O Node não abre o arquivo com bloqueio de escrita nem executa a
  partir do identificador aberto; entre a verificação e o início do processo,
  alguém com escrita na pasta pode trocar o arquivo e devolvê-lo antes da
  segunda verificação. A conferência depois da execução só detecta trocas
  que permanecem.
- **Permissões da pasta.** Instalado em `Program Files`, só administradores
  escrevem na pasta; instalado por usuário (`AppData\Local`), o próprio
  usuário (e qualquer programa dele) pode trocar o auxiliar **e** o pacote do
  app, que contém o hash esperado. O hash protege contra corrupção e troca
  casual, não contra quem já escreve na pasta do app. O executor não confere
  as ACLs (exigiria código nativo ou PowerShell).
- **Autenticidade.** O hash prova só que o arquivo é o que o build gerou.
  Assinatura Authenticode e sua verificação (`WinVerifyTrust`, código nativo
  ou PowerShell) ficam para quando o empacotador e o certificado existirem.
- **Processos descendentes.** `kill` encerra só o processo iniciado; filhos
  dele sobreviveriam (Job Object exige código nativo). O auxiliar não pode
  iniciar processos (requisito da 6C.3, verificado na revisão do código C++).
- **Desenvolvimento × empacotado.** A mesma política vale nos dois; em
  desenvolvimento a pasta do projeto é, em geral, gravável pelo usuário.
- **Hash nulo.** Até a 6C.3 o auxiliar está bloqueado; o valor real só pode
  entrar junto com o binário revisado e o processo de build que o gera.

### Código-fonte do auxiliar (Etapa 6C.3B.1; compilado na 6C.3B.2B)

`native/dxcore-helper/` (C++17, Win32 e headers oficiais do DXCore, sem
dependências de terceiros); detalhes, contratos do SDK conferidos e
procedimento de build em `native/dxcore-helper/README.md` (D57).

Na 6C.3B.2B o auxiliar foi compilado com MSVC v143 (14.44.35207) e Windows
SDK 10.0.26100.0, sem avisos com `/W4 /WX`, reproduzível em dois builds
limpos e conferido pelo `pe-inspect.ts` e pelo `dumpbin`. Só os testes C++
sintéticos (`tests/serializer_tests.cpp`, adaptadores simulados) foram
executados: 98 verificações, 0 falhas. O auxiliar em si nunca foi executado;
o binário fica só na máquina (pastas ignoradas pelo git) e o hash continua
`null` no app.

- Linha de comando diferente de `--protocol 1` → 64, antes de carregar algo.
  Saída padrão que não seja pipe → 13. Proteções de carregamento não
  estabelecidas → 10 (o app trata como DXCore indisponível). Mais de 16
  adaptadores, adaptador inválido ou lista alterada durante a leitura → 12.
  Nenhum código novo.
- Cada propriedade: suportada, tamanho exato do tipo e leitura sem falha;
  senão `null` só naquele campo. `DriverDescription` só como UTF-8 válido
  (codificação não documentada); outra codificação vira `null`.
- Resposta montada inteira num buffer fixo antes da escrita.
- O app confere o código-fonte sem compilá-lo
  (`tests/main/dxcore-native-sources.test.ts`): argumentos, códigos de saída,
  limites, ordem das chaves e o conjunto removido da descrição iguais ao
  contrato; as respostas esperadas pelos testes C++ aceitas pelo parser;
  nenhuma API de processo, arquivo, Registro, rede ou log; `dxcore.dll` só da
  System32.
- Build: `scripts/native/build-dxcore-helper.mjs` (exige confirmação, MSVC
  v143 e Windows SDK; não instala, não executa o que compila, não aplica o hash) e
  `scripts/native/pe-inspect.ts` (confere o binário: x64, console, ASLR,
  DEP, CFG, CET, `DependentLoadFlags = 0x800`, só `KERNEL32.dll`).
- Job Object e `MicrosoftSignedOnly`/`ProhibitDynamicCode`: não ativados
  (D57).

### Diagnóstico manual (supervisor e pasta temporária)

Decisão D55. Ponto de entrada `node scripts/diagnostics/run-hardware-diagnostic.mjs`
(Node, não Electron). Sem confirmação, só mostra o plano, sem iniciar o
Electron; as duas confirmações juntas são recusadas antes de iniciar.

1. O supervisor cria uma pasta exclusiva (`mkdtemp`, prefixo
   `gerpro-hwdiag-`) direto na pasta temporária do sistema e guarda caminho,
   dispositivo e inode.
2. Inicia o Electron (`hardware-diagnostic.mjs`, sem shell) com a pasta numa
   variável de ambiente. O Electron só aceita a pasta se for absoluta, direto
   na pasta temporária, com o prefixo e diretório real (não link); senão sai
   sem iniciar nada. Ele não cria nem apaga pastas.
3. O supervisor espera o processo encerrar (`close`). Ctrl+C chega também ao
   Electron, que cancela a coleta; se ele não sair em 5 s, ou num segundo
   Ctrl+C, o supervisor força o encerramento. Prazo total do processo: 120 s.
4. Só depois disso remove a pasta que criou, e só ela: confere que continua
   direto na pasta temporária, com o mesmo dispositivo e inode, e que não é
   link. Links dentro dela são apagados como entrada, sem seguir o destino.
   Arquivos ainda presos por processos do Chromium que acabaram de sair: até
   10 tentativas, com espera crescente.
5. Falha de limpeza: informada só com o motivo e o código do erro, sem
   caminho; diagnóstico bem-sucedido sai com o código 72.

Não há varredura por prefixo nem remoção de pastas de outras execuções.
**Limitação:** se o supervisor for encerrado à força (fechar o terminal,
Gerenciador de Tarefas, desligamento), a pasta pode ficar na pasta temporária
do sistema; ela não é removida automaticamente depois.

#### Modo DXCore (Etapa 6C.4A, D58; preparado, ainda não executado)

`--confirm-dxcore-helper-read`, exclusivo com as outras confirmações. Executa
o auxiliar **uma vez** para diagnóstico, sem alterar o app:

1. **Supervisor (Node), antes de iniciar o Electron:** `whoami.exe /groups /fo
   csv /nh` (nível de integridade pelo SID do rótulo obrigatório; elevado ou
   desconhecido recusa) e `tasklist.exe` filtrado pelo nome do auxiliar
   (qualquer processo dele em execução recusa); os dois sem shell, da
   System32, com prazo, e a saída só é interpretada, nunca impressa. Depois,
   trava exclusiva `gerpro-dxcore-diagnostic.lock` na pasta temporária
   (`wx`): outro diagnóstico DXCore em andamento recusa. Recusa: código 4,
   sem iniciar o Electron.
2. **Electron, antes de executar:** pré-condições
   (`scripts/diagnostics/dxcore-diagnostic.ts`): Windows x64;
   `DXCORE_HELPER_SHA256` do app ainda `null`; pasta de recursos confiável e
   sem redirecionamento; auxiliar arquivo comum, sem link ou junção; tamanho e
   SHA-256 iguais aos do build aprovado; `build-manifest.json` e a cópia da
   pasta de build com o mesmo hash (o arquivo não mudou depois do build);
   política do PE (`pe-inspect.ts`). Qualquer falha: código 4, nada executado.
3. **Execução:** um `BundledHelperRunner` novo e uma chamada a `run`, sem
   nova tentativa. É o executor de produção, com todas as verificações dele
   (inclusive o hash antes e depois, prazo de 3 s, 64 KiB/4 KiB, ambiente
   mínimo). O hash esperado vem da injeção `expectedSha256`, com o valor do
   build aprovado fixo no próprio diagnóstico.
4. **Comparação, só da GPU:** `getGPUInfo('basic')` e as duas consultas do
   Registro do catálogo (cada uma no máximo uma vez), a seleção simulada
   (`selectGpuList`) e a concordância de VRAM. CPU, memória, armazenamento e
   sistema não são consultados; nenhum perfil é gravado.
5. **Depois que o Electron encerra:** o supervisor confere com `tasklist.exe`
   que nenhum processo do auxiliar ficou (código 5 se ficou) e remove a trava.

O relatório traz só códigos, contagens, fabricante (pelo identificador PCI do
fabricante), presença dos campos, coerência dos LUIDs e memórias em GiB:
nunca a saída bruta, nomes de GPU, identificadores do dispositivo, LUIDs,
caminhos ou o usuário.

### Interrupção da análise (cancelamento e prazo global)

`HardwareAdvisorService` dá a `detect()` um prazo global (15 s;
`detectTimeoutMs` injetável só em testes, inteiro de 1 a 60 000 ms).

- Análise interrompida (`DetectionAbortedError` de
  `src/main/hardware/detection-errors.ts`, sinal disparado, ou resultado que
  chegou depois do prazo) não grava nada: nem perfil, nem registro de erro.
  O último perfil e o consentimento ficam como estavam. O erro é
  `AppError('invalid-state')`, repetível, com `details.aborted` igual a
  `cancelled` ou `timeout`; `ErrorCode` e o IPC não mudaram.
- O serviço não espera além do prazo: um detector que ignora o sinal é
  abandonado, e o que ele entregar depois é descartado sem validar.
- Falha comum do detector continua virando um registro `error`; falha
  parcial de sondagem continua sendo um perfil concluído.
- O resultado só é gravado se a decisão de consentimento (status, data e
  escopo) for a mesma do início da análise: revogar, ou revogar e autorizar
  de novo durante a análise, descarta o resultado.

### Detector local (`LocalHardwareDetector`, ainda não conectado)

`src/main/hardware/local/local-hardware-detector.ts` compõe as sondagens de
CPU, memória, sistema, armazenamento e GPU num perfil v4
(`source: 'local-detector'`, `detectorId: 'local-hardware'`). O serviço
continua usando `UnimplementedLocalDetector`; a ligação com o consentimento
`device-detection` fica para a próxima etapa.

- Composição: CPU, memória e sistema (síncronas) em sequência; armazenamento
  e GPU em paralelo. Cada sondagem é isolada: falha ou exceção dela vira
  atributos `unavailable` só dela. O perfil sai válido mesmo com todas
  falhando. `acceleration` não é sondada (`null`).
- Cancelamento e prazo: o `AbortSignal` recebido vale para a coleta inteira.
  Cancelada antes ou durante, nenhuma sondagem nova começa, nada é devolvido
  (nem resultados que cheguem depois) e `detect()` rejeita com
  `DetectionAbortedError` (`cancelled` ou `timeout`, pelo motivo do sinal;
  ver "Interrupção da análise").
  O prazo de uma sondagem não cancela a coleta: só deixa os atributos dela
  indisponíveis (motivo `timeout`).
- Prazos (`DETECTION_BUDGET`, injetáveis nos testes): disco 5 s,
  `getGPUInfo` 4 s e orçamento total da GPU 11 s. Os prazos nominais da GPU
  somariam 18 s (4 s + 2 × (5 s de consulta + até 2 s esperando o processo
  encerrar)), acima dos 15 s que o serviço dá a `detect()`; com o orçamento,
  o pior caso é 11 s + 2 s de encerramento = 13 s, e a GPU sai com a VRAM
  indisponível (`registry-timeout`) em vez de a coleta inteira estourar.
- Confiança: `high` só com todo atributo (inclusive de GPU) detectado;
  `medium` com os essenciais conhecidos (núcleos lógicos, RAM total e livre,
  `gpus`, espaço livre, plataforma); `low` sem algum deles. Com os núcleos
  físicos e a aceleração sempre indisponíveis, hoje o máximo é `medium`.
- Armazenamento: um único caminho definido pelo Main (`storageTarget`, ex.:
  pasta de dados do app). O caminho não entra no perfil; `collect()` devolve
  só a raiz do volume (ex.: `C:\`) num diagnóstico à parte, junto com os
  motivos de cada atributo indisponível.
- `createLocalHardwareDetector` monta a versão de produção (`getGPUInfo` do
  Electron e `CommandRunner` com o catálogo autorizado) sem executar nada.
  Com `helperResourcesRoot`, inclui o executor do auxiliar DXCore com o hash
  embutido (hoje `null`: sempre recusado, vale o fallback). Ninguém no app
  chama essa montagem ainda.

### Integração do DXCore ao detector (proposta da 6C.5A; estrutura implementada na 6C.5B, D59, sem ativação)

A estrutura abaixo está no código desde a 6C.5B, sem ativação: o serviço
continua com `UnimplementedLocalDetector`, o hash de produção continua
`null` e ninguém no app monta o detector nem resolve a raiz. A ativação
(trocar o detector do serviço, escopo `device-detection`, hash de produção,
empacotamento) são etapas posteriores e separadas.

**Onde entra.** Só na etapa de GPU de `LocalHardwareDetector.collect()`. Uma
dependência nova e opcional, `dxcore?: { run(signal): Promise<HelperRunResult> }`:
sem ela, o detector é exatamente o de hoje. Com ela:

1. Em paralelo, com o mesmo `gpuSignal` (sinal global ∪ orçamento de 11 s):
   - `dxcore.run(gpuSignal)` → `interpretHelperResult` → `DxcoreSource`. É o
     único ponto que lê a saída do auxiliar; ela não sai dali;
   - `probeGpus` exatamente como hoje, mas com `getGPUInfo` e `runCommand`
     envolvidos por uma camada transparente que guarda o retorno bruto do
     `getGPUInfo` e o resultado de cada consulta do Registro (cada uma no
     máximo uma vez por coleta). Daí sai o `RegistrySnapshot`, sem consulta
     extra. A camada é `captureGpuSources` (`local/dxcore/capture.ts`),
     usada pelo detector e pelo diagnóstico manual (que antes tinha uma cópia
     própria, `snapshotFrom`).
2. `selectGpuList({ dxcore, electron: { result, raw }, registry })` decide a
   fonte uma vez para a lista toda; `gpusToProfile(selection.result)` monta o
   perfil. O diagnóstico interno (`LocalDetectionDiagnostics`, que não passa
   pelo IPC) ganha `gpuSource`: `{ source, dxcoreStatus, parseError,
   rejection, traces, helperStop, helperProcess }`, só com valores
   enumerados (sem LUID, identificador PCI, nome, caminho ou saída). Sem a
   dependência: `{ source: 'electron', dxcoreStatus: 'not-queried',
   parseError: null, rejection: null, traces: [], helperStop: null,
   helperProcess: 'not-queried' }`.

**Fallback intacto.** `probeGpus` roda sempre, com a mesma entrada. Em
qualquer recusa, `selectGpuList` devolve **o mesmo objeto** `GpuProbeResult`
do Electron + Registro (identidade conferida nos testes da 6C.2). Isso cobre
auxiliar ausente, recusado, com timeout, cancelado, falho, resposta inválida,
lista incoerente ou composição diferente. Os testes da 5B
(`dxcore-detector.test.ts`) conferem, em cada um desses casos, perfil e
diagnóstico (fora `gpuSource`) iguais por `deepEqual` aos do detector sem a
dependência, e as mesmas consultas ao Registro.

**`resourcesRoot`.** Resolvido só no Main, pela função pura
`resolveHelperResourcesRoot({ isPackaged, appPath, resourcesPath })`
(`local/helper-root.ts`; o Main passa os valores de `app` e `process`),
nunca vindo de IPC, Renderer, configurações, variável de ambiente ou
argumento de linha de comando. Valor recusado devolve `null` (sem auxiliar),
sem trocar de fonte:

| Situação | Raiz |
| --- | --- |
| Empacotado (`app.isPackaged`) | `process.resourcesPath` (fora do asar) |
| Desenvolvimento | `<app.getAppPath()>\resources` (raiz do projeto com `electron-vite`) |

A raiz passa por `isTrustedRoot`: local, absoluta, normalizada, sem `..`,
sem caminho de rede ou de dispositivo. O executor completa o caminho com
nome, subpasta e arquitetura fixos e confere `realpath` (sem link ou junção).
Raiz inválida resulta em `location-invalid` e no fallback. Em desenvolvimento,
com o hash `null`, o auxiliar é sempre recusado; depois de preenchido, só um
build reproduzível idêntico ao aprovado passa.

**Hash.** `DXCORE_HELPER_SHA256` continua `null` até uma mudança própria,
revisada, depois do empacotamento definido. Esse valor vem de um build limpo
e reproduzível conferido contra o `build-manifest.json`, e não é copiado do
diagnóstico (`APPROVED_DXCORE_BUILD` existe só no script). O executor confere
o hash antes e depois; arquivo trocado descarta a saída.

**Cancelamento e prazos.**
- O auxiliar usa o `gpuSignal`: o cancelamento global encerra o processo e a
  coleta rejeita com `DetectionAbortedError`, como hoje.
- Estourar o orçamento da GPU segue a política atual (GPU identificada, VRAM
  `registry-timeout`); o auxiliar recebe o mesmo sinal, é encerrado e a fonte
  fica `cancelled`; o detector distingue o motivo pelos sinais
  (`helperStop: 'gpu-budget'`, 6C.5C), e vale o fallback.
- Motivos distintos: cancelamento do usuário → `DetectionAbortedError('cancelled')`;
  prazo global do serviço → `DetectionAbortedError('timeout')` (nos dois, nada
  é devolvido); orçamento da GPU → `helperStop: 'gpu-budget'`; prazo do
  próprio auxiliar → `dxcoreStatus: 'timeout'`, `helperStop: 'helper-timeout'`;
  falha no encerramento → `helperProcess: 'kill-failed'` ou
  `'exit-unconfirmed'`.
- Prazo próprio do auxiliar: 3 s, mais até 2 s de encerramento (5 s). Ele roda
  em paralelo com `getGPUInfo` (4 s) e as consultas ao Registro, então cabe
  nos 11 s sem orçamento novo; o pior caso da coleta continua em 13 s.
- Cancelado ainda na fila do executor: não inicia processo.
- Processo sem encerramento confirmado (`processExited: false`): o resultado
  vale como `timeout` ou falha, com `helperProcess` no diagnóstico interno;
  coletas seguintes não iniciam outro processo enquanto ele não terminar
  (fallback). Ver "Encerramento do processo: garantias e limites".

**Execuções duplicadas.**
- O serviço já impede duas análises simultâneas (`running ??=`).
- O detector usa um único executor (fila interna, uma execução por vez) e
  chama `run` uma vez por coleta, sem nova tentativa.
- `availability()` não executa o auxiliar.

**Consentimento.**
- O auxiliar só roda dentro de `detect()`, que o serviço só chama no modo
  real com `consentCovers(consent, 'device-detection')`.
- O escopo concedido hoje é `demo-only`. A detecção real continua impossível
  até a etapa de ativação trocar o escopo, junto com uma tela que diga que o
  hardware será lido, inclusive por um programa auxiliar do próprio app.
- A 5B não tocou no consentimento.

### Distribuição do auxiliar (requisitos para a ativação; revisão da 6C.5A)

- **Pasta de instalação.** Recomendado instalar por máquina (`Program Files`,
  gravável só por administradores). Uma instalação por usuário
  (`%LOCALAPPDATA%`) fica gravável pelo próprio usuário. O auxiliar roda como
  `asInvoker`, sem privilégio além do app; quem já escreve na pasta já pode
  trocar o próprio app (asar). O hash protege contra corrupção e troca
  casual, não contra esse atacante. Em desenvolvimento, a pasta do projeto é
  gravável.
- **Integridade.** SHA-256 no código (dentro do asar), conferido antes e
  depois de cada execução. Arquivo comum, sem link ou junção, de tamanho
  limitado.
- **Empacotamento x64.** Ainda não há empacotador. Quando houver: recurso
  extra fora do asar em `helpers\win32-x64\gerpro-dxcore-helper.exe`, gerado
  pelo build reproduzível com o manifesto ao lado. O binário não entra no git.
- **Executável ausente.** `not-found`, depois `helper-unavailable` e o
  fallback: perfil igual ao de hoje, sem erro para o usuário.
- **ARM64.** Hash `arm64: null`, então o auxiliar fica recusado e vale o
  fallback. O futuro binário ARM64 precisa de build e hash próprios. Risco: o
  app x64 emulado num Windows ARM64 tem `process.arch === 'x64'` e
  executaria o auxiliar x64 emulado (comportamento do DXCore sob emulação não
  verificado).
- **Assinatura digital.** Authenticode do auxiliar e do app, quando o
  empacotador e o certificado existirem. Complementa o hash, não o substitui.
  `MicrosoftSignedOnly` continua desligado (afeta as DLLs carregadas, não o
  executável).
- **TOCTOU.** O arquivo pode ser trocado entre a conferência e o início do
  processo. A conferência posterior descarta a saída, mas o código trocado
  já terá rodado com os privilégios do usuário. Risco aceito no modelo acima
  e reduzido pela instalação por máquina.
- **Job Object.** Continua pendente. Processos criados pelo auxiliar não são
  impedidos nem encerrados com ele. Launcher nativo com `JOB_LIST`,
  `CREATE_SUSPENDED` e política de processos filhos implementado e compilado
  na 6C.6B.2 (`native/helper-host`), **não executado nem conectado**:
  `docs/10-ativacao-dxcore.md`, seções 17–19.

### Formato do arquivo (`hardware.json` v2)

A v2 acrescentou `provenance.quality` e `physicalCores` anulável.
`migrateHardwareV1` converte a v1 ao abrir o arquivo:

- o consentimento é copiado sem alteração: `demo-only` continua `demo-only`;
- o perfil demonstrativo continua `demo`, com atributos presentes `simulated`
  e ausentes `unavailable`;
- um perfil de detector real da v1 é descartado (a v1 não registrava como cada
  atributo foi obtido), e o consentimento é mantido. Nenhuma versão distribuída
  tinha detector real;
- o original é copiado (`hardware.v1-<data>.json`) e o arquivo é regravado
  em v2 na mesma abertura. Se a gravação falhar, a v1 fica intacta e a
  migração se repete na próxima abertura;
- dados inválidos seguem o caminho seguro de sempre: sem consentimento
  legível, não autorizado e sem dados;
- um app v1 que abra o arquivo v2 o trata como "mais novo": usa os padrões
  (não autorizado) e não grava.

## Consentimento

### Duas finalidades independentes

```ts
interface HardwareConsent {
  localAnalysis: { status, decidedAt, scope }  // análise neste computador
  serverSharing: { status, decidedAt }         // envio ao Gerpro Web
}
```

- **Status:** `not-asked`, `granted`, `denied` ou `revoked`.
- **Análise local não implica envio:** autorizar a análise local não autoriza
  enviar nada. A validação rejeita `serverSharing: granted` nesta versão,
  e a interface mostra o interruptor desativado.
- **Sem autorização, nenhum detector é chamado.** O app funciona normalmente
  sem autorização, e as recomendações ficam como "compatibilidade
  desconhecida".

### Escopo: `demo-only` × `device-detection`

Toda autorização da análise local grava **o que** foi autorizado:

| Escopo | Quando é gravado | O que cobre |
|---|---|---|
| `demo-only` | Toda autorização dada nesta versão (`CURRENT_GRANT_SCOPE`), porque a tela diz que nada do computador é lido | Só análises demonstrativas |
| `device-detection` | Só quando o app for configurado com `grantScope: 'device-detection'`, junto com uma tela que diga claramente que o hardware real será lido | Leitura real **e** demonstração |

Regras (`consentCovers` e `SCOPE_REQUIRED` em `src/shared/hardware.ts`):

- `analyze({ mode: 'demo' })` exige o escopo `demo-only` ou mais amplo.
- `analyze({ mode: 'real' })` exige `device-detection` sempre que o detector
  real estiver disponível.
- Se o detector real estiver **indisponível** (caso atual), nada é lido e
  basta uma autorização vigente. O resultado é gravado como "indisponível".
- O escopo existe só com `status: 'granted'`. A validação rejeita
  autorização sem escopo, com escopo desconhecido ou escopo em registro
  revogado.

### Proteção contra ampliação automática

**Problema evitado:** um usuário autorizou a demonstração numa tela que dizia
"nenhuma informação do seu computador é lida". Se uma versão futura
adicionasse o detector real, essa mesma autorização seria aceita, e o
hardware seria lido sem o consentimento correspondente.

**Garantias:**

1. Autorizações `demo-only` **nunca** são convertidas em `device-detection`.
   Nenhuma migração deve fazer isso.
2. Com um detector real disponível e autorização `demo-only`,
   `hardware:analyze` com `mode: 'real'` falha com `invalid-state` ("é preciso
   uma nova autorização") **antes** de chamar `detect()`. Nada é lido nem
   gravado.
3. A mesma autorização continua valendo para a demonstração.
4. Se a autorização for revogada durante uma análise, o resultado é
   descartado.
5. Um `hardware.json` sem escopo, gravado antes dessa regra, não passa na
   validação e volta ao padrão seguro: não autorizado e sem dados.

Essas garantias são cobertas por testes em
`tests/main/hardware-advisor.test.ts` e `tests/shared/hardware.test.ts`. A
interface mostra o escopo ao lado do status: "somente demonstração; não cobre
leitura real".

### Revogação e exclusão

- **"Desativar autorização":** status `revoked`. Os dados gravados ficam
  ocultos e não são usados.
- **"Desativar e apagar dados"** (com confirmação): revoga e remove a análise
  do disco.
- **"Apagar dados de hardware"** e `hardware:delete-data`: removem a análise
  e mantêm o consentimento.

## Estados exibidos

`deriveAnalysisStatus` calcula seis estados:

| Estado | Quando |
|---|---|
| `not-authorized` | análise local não autorizada |
| `awaiting-analysis` | autorizada, sem análise |
| `unavailable` | a última tentativa não pôde ser feita (detector ausente) |
| `completed` | perfil disponível, com até 30 dias (`STALE_AFTER_DAYS`) |
| `stale` | perfil com mais de 30 dias |
| `error` | a última tentativa falhou |

## Interface

- **Configurações › Hardware e desempenho**
  (`src/renderer/src/components/hardware/HardwarePanel.tsx`):
  - aviso fixo de que a detecção real não existe e de que os dados são
    fictícios;
  - lista do que seria consultado;
  - autorização com escopo;
  - botão de detecção real, que leva a "indisponível";
  - cenários demonstrativos, descritos pelos recursos que simulam: estação com
    GPU dedicada e 32 GB, 8 GB sem GPU dedicada, dados parciais,
    análise antiga e falha simulada do detector;
  - resultado com selo "Dados fictícios: demonstração" e marcação
    "Estimativa", seguido da compatibilidade estimada com processamento local:
    uma conclusão simples e uma sugestão de ação;
  - em **Ver detalhes técnicos** (recolhido por padrão): data, confiabilidade,
    detector, especificações do perfil e motivos da estimativa.
- **Agentes › Recomendações**
  (`src/renderer/src/components/hardware/AgentRecommendations.tsx`): avalia
  os agentes salvos (exceto os arquivados) e os exemplos, com filtro por tipo
  de tarefa. Cada agente mostra o rótulo da estimativa, uma conclusão e uma
  sugestão; os motivos ficam em **Ver detalhes técnicos**, recolhido.

### Linguagem das estimativas

Tudo o que o Advisor conclui é **estimativa** sobre o perfil analisado, nunca
incompatibilidade confirmada (nenhum modelo foi executado):

- os textos falam do perfil e dos modelos que caberiam, sem julgar o
  equipamento ("fraco", "modesto", "insuficiente" e semelhantes não são
  usados);
- recomendações desfavoráveis usam o tom de alerta (`warning`), nunca o de
  erro (`danger`); o vermelho fica para falhas reais, como erro do detector;
- conclusões e sugestões são montadas por `capabilityConclusion` e
  `recommendationConclusion` (`src/renderer/src/lib/advisor.ts`), só a partir
  do resultado já calculado, sem alterar o algoritmo;
- `tests/renderer/advisor-language.test.ts` verifica essas regras.

## Recomendações demonstrativas (`src/shared/recommendations.ts`)

O motor é puro: não depende de React, Electron nem Node.

**Entradas:**

- requisitos declarados do agente, ou estimados a partir do modelo;
- perfil de hardware;
- tipo de tarefa (`chat`, `code`, `research`, `data`, `documents`, `support`
  ou qualquer);
- disponibilidade do modelo;
- catálogo de ferramentas;
- disponibilidade do motor.

**Fatores combinados:** memória (total e livre), GPU/VRAM ou memória
unificada, armazenamento (quando o modelo não está instalado), núcleos de
CPU, aceleração, modelo, ferramentas e motor. Nenhum critério decide sozinho.

**Categorias (`fit`):**

| `fit` | Rótulo (tom) | Regra |
|---|---|---|
| `needs-resources` | Não recomendado (estimativa) — alerta | algum bloqueio estimado (memória abaixo do mínimo sem VRAM que compense, ou disco abaixo do necessário para o download) |
| `unknown` | Não verificado — neutro | sem perfil, sem requisitos ou sem memória identificada |
| `limited` | Compatível com ressalvas (estimativa) — alerta | sem bloqueio, mas com ressalva ou dado secundário não identificado |
| `recommended-local` | Compatível (estimativa) — sucesso | nenhuma ressalva |

- **Justificativas:** cada recomendação traz uma lista de motivos
  (`positive`, `limitation`, `blocker`, `unknown`, `notice`), com fator e
  mensagem em português.
- **Tipo de tarefa:** afeta a ordenação e a justificativa, não a adequação ao
  hardware.
- **Executável agora:** `fit` (adequação ao hardware) é separado de
  `executableNow`. `executableNow` só é verdadeiro com motor disponível,
  modelo instalado, ferramentas implementadas e `fit` favorável. Hoje
  `engineAvailable` é `false`, então **nenhuma recomendação indica agente
  executável**.
- **Estimativas:** `estimateRequirementsFromModel` estima a memória, a VRAM, o
  disco e os núcleos a partir do tamanho e do contexto do modelo. Requisitos
  declarados (`src/renderer/src/data/agent-requirements.ts`) prevalecem.
- **Compatibilidade local:** `estimateLocalCapability` resume a
  compatibilidade geral com processamento local em `high`, `medium`, `low`,
  `insufficient` ou `unknown`, exibidos como "Modelos grandes e médios",
  "Modelos pequenos e médios", "Modelos pequenos", "Pouca folga para modelos
  locais" (alerta) e "Não verificado".
