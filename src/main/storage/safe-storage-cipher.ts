import { safeStorage } from 'electron'
import type { SecretCipher } from './secret-vault'

/** Cifra do sistema operacional fornecida pelo Electron. */
export const safeStorageCipher: SecretCipher = {
  // No Linux, o backend 'basic_text' não protege nada; tratamos como indisponível.
  isAvailable: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (cipher) => safeStorage.decryptString(cipher)
}
