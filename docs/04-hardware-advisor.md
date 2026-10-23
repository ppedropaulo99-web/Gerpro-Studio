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
| `cpu` | modelo, arquitetura, núcleos físicos e lógicos | `null` |
| `memory` | total e disponível (GB) | `null` |
| `gpus` | fabricante, modelo, VRAM, memória compartilhada | `null` = não identificável; `[]` = nenhuma GPU |
| `storage` | livre e total (GB) | `null` |
| `os` | plataforma, versão e arquitetura | `null` |
| `acceleration` | `avx2`, `avx512`, `neon`, `cuda`, `rocm`, `metal`, `vulkan`, `directml` | `null` = não identificável; `[]` = nenhuma |
| `provenance` | `source` (`demo` \| `local-detector`), `detectorId`, `collectedAt`, `confidence` (`high` \| `medium` \| `low`) | obrigatório |

O perfil não aceita identificadores do usuário nem números de série: campos
extras são rejeitados por `validateHardwareProfile`. O Main valida todo perfil
devolvido por um detector antes de gravá-lo. Um perfil inválido vira estado de
erro, nunca dado gravado.

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
