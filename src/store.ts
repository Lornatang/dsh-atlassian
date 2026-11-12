import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

export interface StoredSession {
  version: 1
  redirectUri?: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
  site?: string
  serverCredentials?: ServerCredentials
}

export interface ServerCredential { username?: string; secret: string }
export interface ServerCredentials { jira?: ServerCredential; confluence?: ServerCredential }

/** Keep credentials separate for each DSH profile and server. */
export function sessionFileFor(serverName: string, url: string, patchPath?: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(serverName)) {
    throw new Error('atlassian: serverName must contain only letters, numbers, underscores or hyphens')
  }
  const profilePatch = patchPath ?? join(process.env['DSH_HOME'] || join(homedir(), '.dsh'), 'profiles', 'web', 'cordis.patch.yml')
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 12)
  return join(dirname(profilePatch), 'data', `atlassian-bridge-${serverName}-${digest}.json`)
}

/** Reject symlinks and files that cannot be restricted to the service user. */
async function secureExistingFile(file: string): Promise<FileHandle | undefined> {
  let info
  try { info = await lstat(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile()) throw new Error(`atlassian: credential file must be a regular file: ${file}`)
  let handle: FileHandle
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`atlassian: credential file must be a regular file: ${file}`)
    throw error
  }
  try {
    info = await handle.stat()
    if (!info.isFile()) throw new Error(`atlassian: credential file must be a regular file: ${file}`)
    if (process.platform !== 'win32') {
      if (typeof process.geteuid === 'function' && info.uid !== process.geteuid()) {
        throw new Error(`atlassian: credential file must be owned by the service user: ${file}`)
      }
      await handle.chmod(0o600)
      info = await handle.stat()
      if ((info.mode & 0o077) !== 0) throw new Error(`atlassian: cannot secure credential file: ${file}`)
    }
    return handle
  } catch (error) { await handle.close(); throw error }
}

/** Serialize state changes and replace the file only after a complete write. */
export class SessionStore {
  readonly #file: string
  #value: StoredSession = { version: 1 }
  #tail: Promise<unknown> = Promise.resolve()

  constructor(file: string) { this.#file = file }
  get file(): string { return this.#file }
  get current(): StoredSession { return this.#value }

  async load(): Promise<StoredSession> {
    return this.#serialize(async () => {
      const handle = await secureExistingFile(this.#file)
      if (!handle) return this.#value = { version: 1 }
      let raw: string
      try { raw = await handle.readFile('utf8') } finally { await handle.close() }
      let parsed: unknown
      try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch (error) {
        throw new Error(`atlassian: invalid credential file: ${this.#file}`, { cause: error })
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as StoredSession).version !== 1) {
        throw new Error(`atlassian: invalid credential file: ${this.#file}`)
      }
      this.#value = parsed as StoredSession
      return this.#value
    })
  }

  async patch(patch: Partial<StoredSession>): Promise<void> {
    await this.#serialize(async () => {
      const next = { ...this.#value, ...patch, version: 1 as const }
      await this.#flush(next)
      this.#value = next
    })
  }

  async clear(...fields: readonly (keyof StoredSession)[]): Promise<void> {
    await this.#serialize(async () => {
      const next: StoredSession = { ...this.#value, version: 1 }
      for (const field of fields) if (field !== 'version') delete next[field]
      await this.#flush(next)
      this.#value = next
    })
  }

  async destroy(): Promise<void> {
    await this.#serialize(async () => {
      await (await secureExistingFile(this.#file))?.close()
      await rm(this.#file, { force: true })
      this.#value = { version: 1 }
    })
  }

  async #flush(value: StoredSession): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
    await (await secureExistingFile(this.#file))?.close()
    const temporary = `${this.#file}.${randomBytes(12).toString('hex')}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync() } finally { await handle.close() }
      await rename(temporary, this.#file)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work)
    this.#tail = run.then(() => undefined, () => undefined)
    return run
  }
}
