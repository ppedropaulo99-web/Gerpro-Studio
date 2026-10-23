import logoUrl from '@renderer/assets/brand/gerpro-25-anos.svg'
import { cx } from '@renderer/lib/cx'

interface BrandLogoProps {
  /** Altura do logo em pixels; a largura segue a proporção original. */
  height: number
  /** Quando o nome já aparece por perto, o logo é só decorativo para leitores de tela. */
  decorative?: boolean
  className?: string
}

/**
 * Logo oficial Gerpro 25 anos, convertido do PDF do estúdio sem alterar
 * geometria, cores ou proporções. Abaixo de ~44 px de altura "GERPRO" perde
 * legibilidade: não usar em tamanhos menores.
 */
export function BrandLogo({ height, decorative = false, className }: BrandLogoProps) {
  return (
    <span className={cx('brand-logo', className)}>
      <img src={logoUrl} alt={decorative ? '' : 'Gerpro 25 anos'} height={height} draggable={false} />
    </span>
  )
}
