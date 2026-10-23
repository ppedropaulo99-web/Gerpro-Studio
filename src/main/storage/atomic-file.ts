import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

// No Windows, antivírus e indexador podem segurar o arquivo por instantes.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_ATTEMPTS = 5

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Grava o arquivo de forma atômica: escreve um temporário no mesmo diretório,
 * força a gravação em disco e o renomeia sobre o destino. Um leitor vê o
 * conteúdo antigo ou o novo, nunca um arquivo pela metade.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)

  try {
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    for (let attempt = 1; ; attempt++) {
      try {
        await rename(tmp, filePath)
        return
      } catch (error) {
        if (attempt >= RENAME_ATTEMPTS || !RENAME_RETRY_CODES.has(errorCode(error) ?? '')) throw error
        await delay(20 * attempt)
      }
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Lê um arquivo de texto; devolve `null` se ele não existir. */
export async function readTextFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}
