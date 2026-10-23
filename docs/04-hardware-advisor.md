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
  - cenários demonstrativos: estação com GPU, computador modesto, dados
    parciais, análise antiga e falha do detector;
  - diagnóstico com selo "Dados fictícios: demonstração", data, confiabilidade
    e detector;
  - compatibilidade estimada com processamento local.
- **Agentes › Recomendações**
  (`src/renderer/src/components/hardware/AgentRecommendations.tsx`): avalia
  os agentes salvos (exceto os arquivados) e os exemplos, com filtro por tipo
  de tarefa.

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

| `fit` | Rótulo | Regra |
|---|---|---|
| `needs-resources` | Requer recursos adicionais | algum bloqueio (memória insuficiente sem VRAM que compense, ou disco insuficiente) |
| `unknown` | Compatibilidade desconhecida | sem perfil, sem requisitos ou sem memória identificada |
| `limited` | Compatível com limitações | sem bloqueio, mas com limitação ou dado secundário desconhecido |
| `recommended-local` | Recomendado para execução local | nenhuma ressalva |

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
  `insufficient` ou `unknown`.
