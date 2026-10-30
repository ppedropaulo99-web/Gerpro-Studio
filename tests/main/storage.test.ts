import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AppError } from '../../src/main/errors'
import { writeFileAtomic } from '../../src/main/storage/atomic-file'
import { SecretVault, type SecretCipher } from '../../src/main/storage/secret-vault'
import { VersionedStore, type ParseOutcome } from '../../src/main/storage/versioned-store'
import { isRecord } from '../../src/shared/validation'
import { tempDir } from '../support/fixtures'

interface Counter {
  count: number
}

function parseCounter(data: unknown): ParseOutcome<Counter> {
  if (isRecord(data) && typeof data['count'] === 'number' && Number.isInteger(data['count']) && data['count'] >= 0) {
    return { value: { count: data['count'] }, issues: [] }
  }
  return { value: undefined, issues: [{ path: '$.count', message: 'inteiro ≥ 0' }] }
}

function counterStore(filePath: string, extra: Partial<ConstructorParameters<typeof VersionedStore<Counter>>[0]> = {}) {
  return new VersionedStore<Counter>({
    filePath,
    format: 'test.counter',
    version: 2,
    defaults: () => ({ count: 0 }),
    parse: parseCounter,
    migrations: { 1: (d) => ({ count: isRecord(d) ? d['value'] : 0 }) },
    log: () => undefined,
    ...extra
  })
}

const envelope = (data: unknown, formatVersion = 2) => JSON.stringify({ format: 'test.counter', formatVersion, savedAt: 'x', data })

describe('escrita atômica', () => {
  it('cria diretórios, grava, substitui e não deixa temporários', async () => {
    const dir = await tempDir()
    const file = join(dir, 'nested', 'a.json')
    await writeFileAtomic(file, 'um')
    await writeFileAtomic(file, 'dois')
    assert.equal(await readFile(file, 'utf8'), 'dois')
    assert.deepEqual(await readdir(join(dir, 'nested')), ['a.json'])
  })

  it('gravações concorrentes resultam em um conteúdo inteiro', async () => {
    const dir = await tempDir()
    const file = join(dir, 'race.json')
    const payloads = Array.from({ length: 10 }, (_, i) => String(i).repeat(10_000))
    await Promise.all(payloads.map((p) => writeFileAtomic(file, p)))
    assert.ok(payloads.includes(await readFile(file, 'utf8')))
    assert.deepEqual(await readdir(dir), ['race.json'])
  })
})

describe('armazenamento versionado', () => {
  it('sem arquivo: usa padrões e só grava ao alterar', async () => {
    const dir = await tempDir()
    const file = join(dir, 'c.json')
    const store = counterStore(file)
    assert.deepEqual(await store.load(), { count: 0 })
    assert.equal(store.status.state, 'missing')
    assert.deepEqual(await readdir(dir), [])

    await store.update((c) => ({ count: c.count + 1 }))
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.format, 'test.counter')
    assert.equal(saved.formatVersion, 2)
    assert.deepEqual(saved.data, { count: 1 })

    const reopened = counterStore(file)
    assert.deepEqual(await reopened.load(), { count: 1 })
    assert.equal(reopened.status.state, 'loaded')
  })

  it('alterações concorrentes são serializadas', async () => {
    const dir = await tempDir()
    const store = counterStore(join(dir, 'c.json'))
    await Promise.all(Array.from({ length: 20 }, () => store.update((c) => ({ count: c.count + 1 }))))
    assert.equal(store.get().count, 20)
    assert.deepEqual(await counterStore(join(dir, 'c.json')).load(), { count: 20 })
  })

  it('valor inválido não é gravado e a memória não muda', async () => {
    const dir = await tempDir()
    const file = join(dir, 'c.json')
    const store = counterStore(file)
    await store.update(() => ({ count: 3 }))
    await assert.rejects(store.update(() => ({ count: -1 })), (e: unknown) => e instanceof AppError && e.code === 'validation')
    assert.equal(store.get().count, 3)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).data, { count: 3 })
    // Uma falha não trava a fila.
    await store.update((c) => ({ count: c.count + 1 }))
    assert.equal(store.get().count, 4)
  })

  for (const [name, contents] of [
    ['JSON corrompido', '{"format": "test.cou'],
    ['formato de outro arquivo', JSON.stringify({ format: 'outro', formatVersion: 2, data: { count: 1 } })],
    ['dados inválidos', envelope({ count: 'muitos' })]
  ] as const) {
    it(`${name}: copia o original, recupera com padrões e permite gravar`, async () => {
      const dir = await tempDir()
      const file = join(dir, 'c.json')
      await writeFile(file, contents)
      const store = counterStore(file, { now: () => new Date('2026-10-23T12:00:00Z') })
      assert.deepEqual(await store.load(), { count: 0 })
      assert.equal(store.status.state, 'recovered')
      assert.ok(store.status.issues.length > 0)
      assert.equal(await readFile(store.status.backupPath!, 'utf8'), contents)
      await store.update(() => ({ count: 7 }))
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).data, { count: 7 })
    })
  }

  it('sem `protectOnRecovery`, o arquivo recuperado segue gravável e sem bloqueio declarado', async () => {
    const dir = await tempDir()
    const file = join(dir, 'c.json')
    await writeFile(file, '{ quebrado')
    const store = counterStore(file)
    await store.load()
    assert.equal(store.status.writeBlock, null)
    await store.update(() => ({ count: 1 }))
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).data, { count: 1 })
  })

  it('versão mais nova: não sobrescreve', async () => {
    const dir = await tempDir()
    const file = join(dir, 'c.json')
    const future = envelope({ count: 9, novoCampo: true }, 3)
    await writeFile(file, future)
    const store = counterStore(file)
    assert.deepEqual(await store.load(), { count: 0 })
    assert.equal(store.status.state, 'read-only')
    await assert.rejects(store.update(() => ({ count: 1 })), (e: unknown) => e instanceof AppError && e.code === 'storage-read-only')
    assert.equal(await readFile(file, 'utf8'), future)
  })

  it('versão antiga: aplica migração', async () => {
    const dir = await tempDir()
    const file = join(dir, 'c.json')
    await writeFile(file, envelope({ value: 5 }, 1))
    const store = counterStore(file)
    assert.deepEqual(await store.load(), { count: 5 })
    assert.equal(store.status.state, 'migrated')
  })
})

describe('cofre de credenciais', () => {
  // Cifra de teste: inverte os bytes e marca o prefixo, só para provar que o texto puro não vai ao disco.
  const fakeCipher = (available = true): SecretCipher => ({
    isAvailable: () => available,
    encrypt: (plain) => Buffer.concat([Buffer.from('ENC:'), Buffer.from(plain, 'utf8').reverse()]),
    decrypt: (cipher) => Buffer.from(cipher.subarray(4)).reverse().toString('utf8')
  })

  it('grava somente texto cifrado e lê de volta', async () => {
    const dir = await tempDir()
    const file = join(dir, 'secrets.json')
    const vault = new SecretVault(file, fakeCipher())
    await vault.set('openai-key', 'sk-super-secreto')
    assert.equal(await vault.get('openai-key'), 'sk-super-secreto')
    assert.equal((await readFile(file, 'utf8')).includes('sk-super-secreto'), false)
    assert.equal(await new SecretVault(file, fakeCipher()).get('openai-key'), 'sk-super-secreto')
    await vault.delete('openai-key')
    assert.equal(await vault.has('openai-key'), false)
  })

  it('sem criptografia do sistema, recusa gravar', async () => {
    const dir = await tempDir()
    const vault = new SecretVault(join(dir, 'secrets.json'), fakeCipher(false))
    await assert.rejects(vault.set('k', 'v'), (e: unknown) => e instanceof AppError && e.code === 'secret-storage-unavailable')
    assert.deepEqual(await readdir(dir), [])
  })
})
