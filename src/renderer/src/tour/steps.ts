/**
 * Roteiro da Apresentação Guiada: declarativo, em capítulos.
 *
 * Cada etapa aponta para um componente REAL de uma tela existente, marcado no
 * JSX com `data-tour="<target>"`. Para incluir uma etapa, basta acrescentar um
 * item aqui (e a marcação no componente); o total é calculado sozinho.
 * Nenhuma etapa executa ação: o roteiro só tem texto e destinos.
 */

import type { RouteId } from '@renderer/app/route-ids'

/** Estado da funcionalidade apresentada. */
export type TourFeatureState = 'implemented' | 'demo' | 'development' | 'planned'

export interface TourChapter {
  id: string
  title: string
}

export interface TourStep {
  /** Estável: não mude depois de publicado (futuras referências e testes). */
  id: string
  chapter: string
  title: string
  description: string
  route: RouteId
  /** Valor de `data-tour` do componente destacado. */
  target: string
  feature: TourFeatureState
}

export const TOUR_FEATURE_LABELS: Record<TourFeatureState, string> = {
  implemented: 'Implementada',
  demo: 'Demonstrativa',
  development: 'Em desenvolvimento',
  planned: 'Planejada'
}

export const TOUR_CHAPTERS: readonly TourChapter[] = [
  { id: 'overview', title: 'Visão geral' },
  { id: 'conversations', title: 'Conversas' },
  { id: 'chat', title: 'Gerpro AI' },
  { id: 'agents', title: 'Agentes' },
  { id: 'models', title: 'Modelos' },
  { id: 'runs', title: 'Execuções' },
  { id: 'tools', title: 'Ferramentas' },
  { id: 'system', title: 'Sistema e privacidade' }
]

export const TOUR_STEPS: readonly TourStep[] = [
  // Visão geral
  {
    id: 'overview.navigation',
    chapter: 'overview',
    title: 'Navegação principal',
    description:
      'Todas as áreas do Gerpro Studio ficam nesta barra: o espaço de trabalho (conversas, Gerpro AI, agentes, modelos, execuções e ferramentas) e o sistema (desenvolvedor e configurações).',
    route: 'home',
    target: 'shell.sidebar',
    feature: 'implemented'
  },
  {
    id: 'overview.stats',
    chapter: 'overview',
    title: 'Indicadores do espaço de trabalho',
    description:
      'Os números vêm dos dados gravados neste computador: agentes salvos e execuções reais e simuladas da sessão. Modelos carregados e tokens ainda estão planejados.',
    route: 'home',
    target: 'home.stats',
    feature: 'implemented'
  },
  {
    id: 'overview.recent-runs',
    chapter: 'overview',
    title: 'Execuções recentes',
    description:
      'Resumo das execuções desta sessão, cada uma marcada como real (modelo instalado neste computador) ou simulada. O histórico é descartado ao fechar o aplicativo.',
    route: 'home',
    target: 'home.recent-runs',
    feature: 'implemented'
  },

  // Conversas
  {
    id: 'conversations.composer',
    chapter: 'conversations',
    title: 'Conversar com um modelo local',
    description:
      'Em Conversas você escolhe um modelo instalado neste computador, escreve e envia; a resposta aparece enquanto é gerada, e dá para interromper. As mensagens anteriores da conversa vão junto como contexto, até o limite do modelo, e o modelo pode ser trocado no meio da conversa.',
    route: 'conversations',
    target: 'conversations.composer',
    feature: 'implemented'
  },
  {
    id: 'conversations.messages',
    chapter: 'conversations',
    title: 'Conversas salvas',
    description:
      'Suas conversas ficam gravadas neste computador e continuam depois de fechar o aplicativo. "Nova conversa" começa outra; pelo menu de cada uma dá para renomear ou excluir.',
    route: 'conversations',
    target: 'conversations.messages',
    feature: 'implemented'
  },

  // Gerpro AI
  {
    id: 'chat.conversations',
    chapter: 'chat',
    title: 'Gerpro AI — Seu assistente inteligente',
    description:
      'O Gerpro AI será o assistente integrado para ajudar a configurar, utilizar e gerenciar o Gerpro Studio: dúvidas, criação de agentes, escolha de modelos e explicação de erros. Ele ainda não funciona.',
    route: 'chat',
    target: 'chat.list',
    feature: 'development'
  },
  {
    id: 'chat.composer',
    chapter: 'chat',
    title: 'Envio de mensagens',
    description: 'Aqui será possível conversar com o Gerpro AI. Por enquanto o campo fica desativado; para falar com um modelo local agora, use Conversas.',
    route: 'chat',
    target: 'chat.composer',
    feature: 'development'
  },

  // Agentes
  {
    id: 'agents.saved',
    chapter: 'agents',
    title: 'Meus agentes',
    description:
      'Agentes com instruções, modelo padrão, parâmetros e ferramentas. São gravados neste computador e podem ser criados, editados, arquivados e excluídos. "Executar" leva a Conversas com o agente escolhido; ferramentas ainda não são executadas.',
    route: 'agents',
    target: 'agents.saved',
    feature: 'implemented'
  },
  {
    id: 'agents.advisor',
    chapter: 'agents',
    title: 'Recomendações do Hardware Advisor',
    description:
      'Cada agente recebe uma estimativa de compatibilidade com os recursos analisados, uma sugestão e os detalhes técnicos do cálculo. Nesta versão, o perfil de hardware é fictício e serve para demonstrar o fluxo.',
    route: 'agents',
    target: 'agents.recommendations',
    feature: 'demo'
  },
  {
    id: 'agents.examples',
    chapter: 'agents',
    title: 'Biblioteca de exemplos',
    description:
      'Agentes de exemplo, com busca e filtro por categoria, para inspirar novas configurações. Não são agentes salvos; cada um pode ser duplicado como ponto de partida.',
    route: 'agents',
    target: 'agents.examples',
    feature: 'demo'
  },

  // Modelos
  {
    id: 'models.library',
    chapter: 'models',
    title: 'Biblioteca de modelos',
    description:
      'Cada modelo mostra publicador, tamanho, capacidades e requisitos; ao selecionar um, os detalhes aparecem ao lado. Esta biblioteca é ilustrativa; os modelos realmente instalados neste computador aparecem acima dela, em "Instalados neste computador".',
    route: 'models',
    target: 'models.library',
    feature: 'demo'
  },
  {
    id: 'models.engine',
    chapter: 'models',
    title: 'Motor de IA local',
    description:
      'Indica se o motor de IA local está respondendo neste computador. Com ele conectado, os modelos instalados podem ser usados em Conversas. A arquitetura separa provedores, modelos e perfis de execução, então o motor pode ser trocado no futuro.',
    route: 'models',
    target: 'shell.engine',
    feature: 'implemented'
  },

  // Execuções
  {
    id: 'runs.monitor',
    chapter: 'runs',
    title: 'Resumo da sessão',
    description:
      'Quantas execuções houve hoje, reais e simuladas, e quantas estão em andamento. Modelos carregados e tokens ainda não são informados pelo motor.',
    route: 'runs',
    target: 'runs.stats',
    feature: 'implemented'
  },
  {
    id: 'runs.session',
    chapter: 'runs',
    title: 'Execuções desta sessão',
    description:
      'Cada execução com origem (real ou simulada), modelo, duração e estado. Ao selecionar uma, aparecem a resposta, as métricas medidas, os erros e o registro técnico; execuções em andamento podem ser interrompidas.',
    route: 'runs',
    target: 'runs.session',
    feature: 'implemented'
  },
  {
    id: 'runs.simulated',
    chapter: 'runs',
    title: 'Demonstração simulada',
    description:
      'Inicia uma execução simulada de um agente salvo pela mesma fila das execuções reais: o provedor simulado responde com texto fixo em partes, e dá para cancelar ou ver uma falha de demonstração. Nenhum modelo roda e nada é gravado no disco. Mensagens para modelos reais são enviadas em Conversas.',
    route: 'runs',
    target: 'runs.launcher',
    feature: 'demo'
  },
  {
    id: 'runs.history',
    chapter: 'runs',
    title: 'Histórico de exemplo',
    description: 'Mostra como o histórico de execuções será organizado, com filtros por status. Os registros são exemplos.',
    route: 'runs',
    target: 'runs.history',
    feature: 'demo'
  },

  // Ferramentas
  {
    id: 'tools.catalog',
    chapter: 'tools',
    title: 'Catálogo de ferramentas',
    description:
      'Cada ferramenta do catálogo informa sua origem, versão e as permissões que declara. O catálogo é real; a execução de ferramentas ainda está planejada.',
    route: 'tools',
    target: 'tools.catalog',
    feature: 'implemented'
  },

  // Sistema e privacidade
  {
    id: 'system.server',
    chapter: 'system',
    title: 'Servidor local',
    description:
      'API local para outros aplicativos usarem os agentes. Ainda não existe: nada escuta em nenhuma porta. Aceitar conexões da rede exigirá uma decisão explícita.',
    route: 'developer',
    target: 'developer.server',
    feature: 'planned'
  },
  {
    id: 'system.app-info',
    chapter: 'system',
    title: 'Informações do aplicativo',
    description: 'Versões do aplicativo e do ambiente, lidas do processo principal.',
    route: 'developer',
    target: 'developer.app',
    feature: 'implemented'
  },
  {
    id: 'system.appearance',
    chapter: 'system',
    title: 'Aparência',
    description: 'Tema escuro ou claro, aplicado e gravado na hora.',
    route: 'settings',
    target: 'settings.appearance',
    feature: 'implemented'
  },
  {
    id: 'system.preferences',
    chapter: 'system',
    title: 'Preferências gerais',
    description: 'Idioma, densidade e inicialização. As escolhas já são gravadas, mas só terão efeito em versões futuras.',
    route: 'settings',
    target: 'settings.general',
    feature: 'planned'
  },
  {
    id: 'system.privacy',
    chapter: 'system',
    title: 'Privacidade e segurança',
    description:
      'Confirmação de ferramentas sensíveis e envio de dados de uso. Enquanto as funções não existem, valem os padrões seguros: confirmação sempre exigida e nenhum dado enviado.',
    route: 'settings',
    target: 'settings.privacy',
    feature: 'planned'
  },
  {
    id: 'system.hardware',
    chapter: 'system',
    title: 'Hardware Advisor',
    description:
      'A análise de hardware só acontece com sua autorização, que mostra antes o que seria consultado e pode ser revogada a qualquer momento. A detecção real ainda não existe: os dados de demonstração são fictícios.',
    route: 'settings',
    target: 'settings.hardware',
    feature: 'demo'
  }
]

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/

/** Problemas de consistência do roteiro; lista vazia = válido. */
export function validateTour(chapters: readonly TourChapter[], steps: readonly TourStep[], routes: readonly string[]): string[] {
  const problems: string[] = []
  const chapterIds = chapters.map((c) => c.id)
  if (new Set(chapterIds).size !== chapterIds.length) problems.push('capítulos com id repetido')
  const seen = new Set<string>()
  let lastChapter = -1
  for (const step of steps) {
    if (!ID_PATTERN.test(step.id)) problems.push(`${step.id}: id inválido`)
    if (seen.has(step.id)) problems.push(`${step.id}: id repetido`)
    seen.add(step.id)
    if (!ID_PATTERN.test(step.target)) problems.push(`${step.id}: alvo inválido`)
    if (!routes.includes(step.route)) problems.push(`${step.id}: tela inexistente (${step.route})`)
    if (!step.title.trim() || !step.description.trim()) problems.push(`${step.id}: título ou descrição vazios`)
    const chapter = chapterIds.indexOf(step.chapter)
    if (chapter === -1) problems.push(`${step.id}: capítulo inexistente (${step.chapter})`)
    // Etapas de um capítulo ficam juntas e na ordem dos capítulos.
    else if (chapter < lastChapter) problems.push(`${step.id}: fora da ordem dos capítulos`)
    else lastChapter = chapter
  }
  for (const id of chapterIds) if (!steps.some((s) => s.chapter === id)) problems.push(`capítulo ${id} sem etapas`)
  return problems
}
