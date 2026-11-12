import z from '@deepseek-ai/schemastery'

export const DEFAULT_CLOUD_URL = 'https://mcp.atlassian.com/v1/mcp'

export interface ServerConfig {
  jiraUrl: string
  confluenceUrl: string
  jiraCaFile: string
  confluenceCaFile: string
  allowInsecureHttp: boolean
}

export interface BoardConfig {
  jql: string
  limit: number
  timeoutMs: number
  promptTemplate: string
}

export interface Config {
  mode: 'cloud' | 'server'
  server: ServerConfig
  serverName: string
  url: string
  redirectPort: number
  toolCallTimeoutMs: number
  expectedSite: string
  authorizationTimeoutMs: number
  autoOpenBrowser: boolean
  board: BoardConfig
}

/** Validate connection settings before persisting them to the DSH profile. */
export function configureEndpoints(current: Config, input: Record<string, unknown>): Config {
  const readText = (name: string, maxLength: number): string => {
    const value = input[name]
    if (typeof value !== 'string' || value.length > maxLength || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${name}`)
    return value.trim()
  }
  const url = (name: string): string => {
    const value = readText(name, 2048)
    if (!value) return ''
    let parsed: URL
    try { parsed = new URL(value) } catch { throw new Error(`Invalid ${name}`) }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`${name} must be an HTTP(S) base URL without credentials or query parameters`)
    }
    return parsed.href.replace(/\/$/, '')
  }
  const jiraUrl = url('jiraUrl')
  const confluenceUrl = url('confluenceUrl')
  const jiraCaFile = readText('jiraCaFile', 4096)
  const confluenceCaFile = readText('confluenceCaFile', 4096)
  const allowInsecureHttp = input['allowInsecureHttp']
  if (typeof allowInsecureHttp !== 'boolean') throw new Error('Invalid allowInsecureHttp')
  if (!allowInsecureHttp && [jiraUrl, confluenceUrl].some((value) => value.startsWith('http:'))) {
    throw new Error('HTTP transmits credentials in plaintext; allow HTTP explicitly or use HTTPS')
  }
  const mode = jiraUrl || confluenceUrl ? 'server' : 'cloud'
  return {
    ...current,
    mode,
    url: mode === 'cloud' ? DEFAULT_CLOUD_URL : current.url,
    server: { jiraUrl, confluenceUrl, jiraCaFile, confluenceCaFile, allowInsecureHttp },
  }
}

export const Config = z.object({
  mode: z.union(['cloud', 'server']).default('cloud'),
  serverName: z.string().default('atlassian'),
  url: z.string().default(DEFAULT_CLOUD_URL),
  redirectPort: z.number().step(1).min(0).max(65535).default(3334),
  toolCallTimeoutMs: z.number().step(1).min(1).default(60000),
  expectedSite: z.string().default(''),
  authorizationTimeoutMs: z.number().step(1).min(1000).default(300000),
  autoOpenBrowser: z.boolean().default(true),
  server: z.object({
    jiraUrl: z.string().default(''),
    confluenceUrl: z.string().default(''),
    jiraCaFile: z.string().default(''),
    confluenceCaFile: z.string().default(''),
    allowInsecureHttp: z.boolean().default(false),
  }),
  board: z.object({
    jql: z.string().default(''),
    limit: z.number().step(1).min(1).max(100).default(50),
    timeoutMs: z.number().step(1).min(1000).default(90000),
    promptTemplate: z.string().default(''),
  }),
})
