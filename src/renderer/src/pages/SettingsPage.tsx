import { useState, type ReactNode } from 'react'
import { Save } from 'lucide-react'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { Button, Card, CardBody, CardHeader, Field, Select, SwitchRow, TextInput } from '@renderer/components/ui'

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} subtitle={description} />
      <CardBody className="stack" style={{ gap: 'var(--space-4)' }}>
        {children}
      </CardBody>
    </Card>
  )
}

export function SettingsPage() {
  // Formulário apenas visual: os valores vivem no estado do componente e não são salvos.
  const [language, setLanguage] = useState('pt-BR')
  const [density, setDensity] = useState('comfortable')
  const [modelsDir, setModelsDir] = useState('C:\\Users\\usuario\\GerproStudio\\models')
  const [maxRam, setMaxRam] = useState('16')
  const [startOnLogin, setStartOnLogin] = useState(false)
  const [telemetry, setTelemetry] = useState(false)
  const [confirmTools, setConfirmTools] = useState(true)

  return (
    <div className="page settings">
      <PageHeader
        title="Configurações"
        description="Preferências do aplicativo. Neste protótipo, nada é gravado."
        actions={
          <Button variant="primary" icon={<Save size={16} />} disabled title="Persistência em uma próxima etapa">
            Salvar alterações
          </Button>
        }
      />

      <Section title="Geral" description="Idioma e comportamento do aplicativo">
        <div className="form-grid">
          <Field label="Idioma">
            {(id) => (
              <Select
                id={id}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                options={[
                  { value: 'pt-BR', label: 'Português (Brasil)' },
                  { value: 'en-US', label: 'English (US)' },
                  { value: 'es', label: 'Español' }
                ]}
              />
            )}
          </Field>
          <Field label="Densidade da interface">
            {(id) => (
              <Select
                id={id}
                value={density}
                onChange={(e) => setDensity(e.target.value)}
                options={[
                  { value: 'comfortable', label: 'Confortável' },
                  { value: 'compact', label: 'Compacta' }
                ]}
              />
            )}
          </Field>
        </div>
        <SwitchRow
          label="Iniciar com o sistema"
          description="Abre o Gerpro Studio minimizado ao entrar no Windows."
          checked={startOnLogin}
          onChange={setStartOnLogin}
        />
      </Section>

      <Section title="Modelos" description="Armazenamento e limites de memória">
        <Field label="Pasta de modelos" hint="Onde os arquivos de modelo serão guardados.">
          {(id) => <TextInput id={id} value={modelsDir} onChange={(e) => setModelsDir(e.target.value)} />}
        </Field>
        <Field label="Limite de RAM para modelos (GB)" hint="Impede carregar modelos que excedam este valor.">
          {(id) => <TextInput id={id} type="number" min={1} value={maxRam} onChange={(e) => setMaxRam(e.target.value)} />}
        </Field>
      </Section>

      <Section title="Privacidade e segurança" description="Controle sobre dados e ações dos agentes">
        <SwitchRow
          label="Confirmar antes de usar ferramentas sensíveis"
          description="Pede aprovação para terminal, escrita em disco e rede."
          checked={confirmTools}
          onChange={setConfirmTools}
        />
        <SwitchRow
          label="Enviar dados de uso anônimos"
          description="Desativado por padrão. Nenhum dado é enviado neste protótipo."
          checked={telemetry}
          onChange={setTelemetry}
        />
      </Section>
    </div>
  )
}
