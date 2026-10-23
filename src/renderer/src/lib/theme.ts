import { THEMES, type SettingsPatch, type Theme } from '@shared/settings'

/** Elemento raiz que recebe o tema (`<html data-theme="...">`). */
export interface ThemeRoot {
  dataset: Record<string, string | undefined>
}

export const themeLabel: Record<Theme, string> = {
  dark: 'Escuro',
  light: 'Claro'
}

export const themeOptions = THEMES.map((value) => ({ value, label: themeLabel[value] }))

/** Tema aplicado no momento; `null` antes da primeira aplicação. */
export function currentTheme(root: ThemeRoot): Theme | null {
  const value = root.dataset['theme']
  return (THEMES as readonly string[]).includes(value ?? '') ? (value as Theme) : null
}

/** Aplica o tema: todos os tokens de cor mudam via `[data-theme]` em `tokens.css`. */
export function applyTheme(root: ThemeRoot, theme: Theme): void {
  root.dataset['theme'] = theme
}

/** Alteração que grava só o tema, sem tocar nos demais campos. */
export function themePatch(theme: Theme): SettingsPatch {
  return { appearance: { theme } }
}
