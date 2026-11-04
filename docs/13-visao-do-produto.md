# Visão funcional e de produto

Documento de produto para a equipe Cognitiva. Ele separa a **visão** (o que o
Gerpro Studio deve ser) do **estado atual** (o que o protótipo faz hoje). A
visão e a priorização são responsabilidade do responsável pelo produto, que
segue como **PM/PO** depois do handoff.

> O protótipo **não está pronto para produção**. Ele serve de referência
> técnica e de ponto de partida, não de produto distribuível.

## 1. O que é o Gerpro Studio

O Gerpro Studio é a **plataforma DIY/low-code para desenvolvimento e
personalização do ecossistema Gerpro**. Ele permite adaptar o Gerpro às
necessidades de cada organização sem depender de desenvolvimento sob medida
para cada mudança.

## 2. Público-alvo

| Perfil | O que espera do Studio |
|---|---|
| Usuários comuns | Ajustar o que usam no dia a dia (campos, telas) de forma guiada e segura |
| Usuários avançados | Criar regras, workflows e layouts mais elaborados |
| Equipes técnicas | Construir personalizações complexas, revisar e publicar mudanças, integrar com o restante do ecossistema |

Cada perfil age **dentro das permissões que tem**. O que um usuário pode ver,
alterar, validar ou publicar depende do perfil e da organização a que
pertence.

## 3. Proposta de valor

- **Autonomia:** a organização adapta o Gerpro sem esperar um ciclo de
  desenvolvimento para cada ajuste.
- **Segurança e controle:** toda mudança passa por validação, permissão e
  publicação controlada, com auditoria.
- **Um só ambiente:** quem personaliza, quem revisa e quem publica trabalham
  na mesma ferramenta, cada um no seu nível.
- **Apoio de IA:** agentes ajudam a criar e a entender as personalizações,
  sem substituir o controle humano.

## 4. Capacidades da visão

Nenhuma destas capacidades está implementada; todas são **planejadas**.

| Capacidade | Descrição na visão |
|---|---|
| Campos | Incluir campos novos e configurar tipo, rótulo, obrigatoriedade, valores e validações |
| Telas e layouts | Personalizar telas existentes e organizar o layout (posição, agrupamento, visibilidade) |
| Regras de negócio | Definir condições e efeitos (validar, calcular, exibir, bloquear) sem programação, ou com programação para as equipes técnicas |
| Workflows | Criar fluxos de etapas, responsáveis e transições |
| Validação | Conferir cada alteração antes de publicar: consistência, conflitos, impacto |
| Permissões | Controlar quem pode criar, alterar, validar e publicar cada tipo de personalização |
| Publicação controlada | Promover mudanças de forma deliberada, com versão, possibilidade de reverter e registro de quem publicou |
| Auditoria e rastreabilidade | Registrar o que mudou, quando, por quem e por quê |

O formato dessas capacidades (modelo de metadados, linguagem de regras,
motor de workflows, ambientes de publicação) ainda **não foi definido**. A
definição cabe à equipe Cognitiva, com validação do PM/PO. Ver o
[Roadmap de engenharia](14-roadmap-de-engenharia.md).

## 5. Agentes de IA: módulo complementar

Os agentes de IA **complementam** a plataforma; não são a finalidade
exclusiva do produto. Na visão, eles podem, por exemplo:

- ajudar a descrever uma personalização em linguagem natural;
- explicar regras e workflows existentes;
- sugerir validações ou apontar inconsistências.

Esses usos são **ideias de evolução**, não funcionalidades existentes. Hoje,
os agentes só conversam: não executam ferramentas e não acessam dados do
Gerpro.

## 6. Existente × planejado

| Área | Existe no protótipo | Planejado |
|---|---|---|
| Base desktop | Electron com isolamento, IPC validado, persistência local versionada | Empacotamento, assinatura, atualização |
| Agentes de IA | Cadastro, editor, conversas gravadas, inferência local pelo Ollama, execuções da sessão | Ferramentas, permissões aplicadas, apoio à personalização |
| Personalização (campos, telas, layouts, regras, workflows) | **Nada** | Motor de personalização completo |
| Validação, permissões, publicação, auditoria | **Nada** (só os padrões técnicos de validação e erro) | Fluxo completo |
| Identidade e organizações | **Nada** (app local, um usuário) | Autenticação e perfis do Gerpro.com |
| Integração com o Gerpro.com | **Nada** (sem cliente, endpoints ou contratos) | APIs e módulos web |
| Hardware Advisor | Consentimento real; recomendações com perfis **fictícios** | Detecção real, hoje dormente e desativada |

Classificação detalhada e verificável: [Inventário e riscos](09-inventario-e-riscos.md).

## 7. Papéis

| Papel | Responsabilidade |
|---|---|
| PM/PO (responsável pelo produto) | Visão, priorização do backlog, regras de produto, aceite das entregas |
| Equipe Cognitiva | Arquitetura definitiva (com autonomia para manter, adaptar ou substituir a do protótipo), integração com o Gerpro.com, motor de personalização, engenharia de produto, segurança e qualidade |
