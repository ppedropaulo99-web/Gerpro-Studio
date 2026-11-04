# Roadmap inicial de engenharia

**Proposta** para a equipe Cognitiva avaliar, ajustar e validar com o PM/PO.
Não é um plano aprovado. **Não há prazos nem estimativas**: não existem
dados para isso, e o dimensionamento cabe à equipe depois da avaliação
inicial.

A equipe Cognitiva tem **autonomia para definir a arquitetura definitiva**. A
arquitetura do protótipo é uma referência que pode ser mantida, adaptada ou
substituída depois da avaliação técnica da Fase 0.

A ordem segue as dependências: cada fase usa decisões das anteriores. Fases
sem dependência entre si podem andar em paralelo, conforme a equipe decidir.

O ponto de partida é o protótipo (ver [Guia de transferência](12-guia-de-transferencia.md)).
Nada aqui está implementado, exceto o que for citado como "base existente".

## Fase 0: Recebimento e avaliação

- Clonar, executar, testar e gerar o build
  ([Checklist de transferência](15-checklist-de-transferencia.md)).
- Avaliar a arquitetura do protótipo e decidir o que é mantido, adaptado ou
  substituído.
- Decidir a forma de convivência com o Gerpro.com: app desktop, web ou
  híbrido. Há uma proposta em
  [Arquitetura › Arquitetura híbrida planejada](02-arquitetura.md#arquitetura-híbrida-planejada-gerpro-web).
- Configurar CI (typecheck, testes e build), lint e o campo `engines`. Os
  supervisores de diagnóstico ficam fora da CI.

**Decisões de saída:** plataforma alvo, estratégia de integração, padrões de
engenharia.

## Fase 1: Integração com o Gerpro.com

- Levantar com o Gerpro.com as capacidades reais: APIs existentes,
  autenticação, ambientes, versionamento.
- Definir e documentar os contratos em [Contratos](03-contratos.md) antes de
  implementar.
- Criar o cliente HTTP no Main, a configuração de ambientes e um canal IPC
  por operação ([Pontos de integração §6](06-pontos-de-integracao.md#6-gerpro-web-apis)).

**Base existente:** `Result<T>`/`StructuredError`, validadores em
`src/shared/`, CSP que força as chamadas pelo Main.

## Fase 2: Autenticação, permissões e segurança

- Login, sessão e renovação de tokens; credenciais no `SecretVault`, que já
  existe e precisa ser instanciado em `createServices`.
- Modelo de organizações, usuários e perfis, com as permissões aplicadas no
  Main, nunca só na interface.
- Revisão de segurança antes de abrir o app à rede:
  - restringir `isAppUrl` ao `index.html` do app;
  - avaliar a remoção de `'unsafe-inline'`;
  - decidir sobre a criptografia das conversas;
  - fazer o contêiner isolado para módulos web, se houver
    ([Pontos de integração §7](06-pontos-de-integracao.md#7-gerpro-web-módulos-incorporados-durante-a-migração)).

**Depende de:** Fase 1 (modelo de identidade do Gerpro.com).

## Fase 3: Modelo de metadados e motor de personalização

- Definir como telas, campos, layouts, regras e workflows são descritos
  (modelo de metadados) e onde ficam: servidor, local ou ambos.
- Definir o versionamento desses metadados e a compatibilidade com o
  Gerpro.com.
- Implementar o núcleo do motor: carregar, validar e aplicar metadados.

**Depende de:** Fase 1 (onde os metadados vivem) e Fase 2 (quem pode
alterá-los).

## Fase 4: Configuração de campos e layouts

- Inclusão e configuração de campos.
- Editor de telas e layouts, com pré-visualização.
- Interfaces adequadas a cada perfil (comum, avançado, técnico).

**Depende de:** Fase 3.

## Fase 5: Workflows e regras de negócio

- Definição de regras (condições e efeitos) e de workflows (etapas,
  responsáveis, transições).
- Escolha da forma de expressão: visual, declarativa, código para equipes
  técnicas ou uma combinação.

**Depende de:** Fase 3. Pode andar em paralelo com a Fase 4.

## Fase 6: Validação, versionamento e publicação

- Validação das alterações antes de publicar: consistência, conflitos,
  impacto.
- Versionamento, ambientes de publicação, reversão.
- Auditoria e rastreabilidade (quem, o quê, quando, por quê) e a política de
  retenção.

**Depende de:** Fases 2, 4 e 5.

## Fase 7: Integrações, testes e distribuição

- Testes de ponta a ponta e testes de componente das telas React (hoje
  inexistentes).
- Empacotamento, assinatura, instalador, atualização e ícone próprio.
- Validação nas plataformas alvo (só Windows 11 foi exercitado).

**Pode começar cedo:** a CI e os testes de componente não dependem das
outras fases.

## Fase 8: Evolução dos agentes de IA (módulo complementar)

- Execução de ferramentas, com concessão de permissões aplicada no Main
  ([Pontos de integração §4](06-pontos-de-integracao.md#4-ferramentas-e-permissões)).
- Apoio à personalização: descrever, explicar e validar personalizações com
  IA, sempre sob controle humano e dentro das permissões do usuário.
- Decisões sobre motor próprio, download de modelos e persistência das
  execuções.

**Base existente:** agentes, conversas, provedor Ollama e `RunService`.
**Depende de:** Fase 3, para os usos ligados à personalização. O restante
pode evoluir em paralelo.

## Fora da sequência: linha de hardware

O detector local e o DXCore estão **dormentes e desativados**. Retomar essa
linha é uma decisão de produto, não um pré-requisito das fases acima. Se ela
for retomada, siga os critérios em
[docs/10 §7](10-ativacao-dxcore.md#7-critérios-objetivos-para-liberar-a-ativação-6c8).
