// SPDX-License-Identifier: MIT
// Host half: reads local tool credentials and exposes only display fields.
// Tokens, account ids, emails and raw upstream payloads never leave this file.
import { readFile } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import path from 'node:path'

const ROUTE = '/dsh-account-ring/providers'
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CACHE_MS = 30_000
const TIMEOUT_MS = 12_000
const execFile = promisify(execFileCallback)

const codexHome = () => process.env.CODEX_HOME || path.join(homedir(), '.codex')
const authFile = () => path.join(codexHome(), 'auth.json')
const manualFile = () => path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'account-ring.json')

let usageCache = { at: 0, value: null }
let tokenCache = { at: 0, accessToken: '', accountId: '', expiresAt: 0, refreshToken: '' }

const clampPercent = (value) => Math.min(100, Math.max(0, Math.round(Number(value))))

function isoFromEpoch(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return new Date(n > 1e12 ? n : n * 1000).toISOString()
}

async function readCodexAuth() {
  let parsed
  try {
    parsed = JSON.parse(await readFile(authFile(), 'utf8'))
  } catch {
    return null
  }
  const tokens = parsed?.tokens
  if (tokens === null || typeof tokens !== 'object' || typeof tokens.access_token !== 'string') return null
  const expiresAt = typeof tokens.expires_at === 'number'
    ? (tokens.expires_at > 1e12 ? tokens.expires_at : tokens.expires_at * 1000)
    : 0
  return {
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '',
    accountId: typeof tokens.account_id === 'string' ? tokens.account_id : '',
    expiresAt,
  }
}

async function refreshCodex(auth) {
  if (!auth.refreshToken) return null
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
      client_id: CLIENT_ID,
    })
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null
    const json = await response.json()
    if (typeof json?.access_token !== 'string' || json.access_token === '') return null
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : auth.refreshToken,
      accountId: auth.accountId,
      expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    }
  } catch {
    return null
  }
}

async function codexToken() {
  const now = Date.now()
  if (tokenCache.accessToken !== '' && tokenCache.expiresAt > now + 30_000) {
    return tokenCache.accessToken
  }
  const auth = await readCodexAuth()
  if (auth === null) return null
  let next = auth
  if (auth.expiresAt > 0 && auth.expiresAt <= now + 30_000) {
    next = (await refreshCodex(auth)) ?? auth
  }
  tokenCache = { ...next, at: now }
  return next.accessToken === '' ? null : next.accessToken
}

function parseUsage(body) {
  const rate = body?.rate_limit
  if (rate === null || typeof rate !== 'object') return []
  const windows = []
  const place = (raw, fallback) => {
    if (raw === null || typeof raw !== 'object') return
    const used = Number(raw.used_percent)
    if (!Number.isFinite(used)) return
    const seconds = Number(raw.limit_window_seconds)
    let id = fallback
    if (Number.isFinite(seconds) && seconds > 0) {
      if (seconds >= 5 * 3600 * 0.95 && seconds <= 5 * 3600 * 1.05) id = 'rolling'
      else if (seconds >= 7 * 24 * 3600 * 0.95 && seconds <= 7 * 24 * 3600 * 1.05) id = 'weekly'
    }
    const percent = clampPercent(used)
    windows.push({
      id,
      label: id === 'rolling' ? '5 小时' : '每周',
      usedPercent: percent,
      remainingPercent: 100 - percent,
      resetsAt: isoFromEpoch(raw.reset_at),
    })
  }
  place(rate.primary_window, 'rolling')
  place(rate.secondary_window, 'weekly')
  return windows
}

async function deepseekProvider(account) {
  const unavailable = { id: 'deepseek', label: 'DeepSeek', kind: 'balance', status: 'unavailable', hint: '登录后可用' }
  if (account === undefined || typeof account.getBalance !== 'function') return unavailable
  try {
    const value = await account.getBalance({
      version: process.env.DSH_CLIENT_VERSION || '0.2.2-rc.3',
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })
    if (value === null || value === undefined || value.status !== 'ready' || !Array.isArray(value.value)) return unavailable
    const wallet = value.value.find((w) => w.currency === 'CNY') ?? value.value[0]
    if (wallet === undefined) return unavailable
    const bonus = (Array.isArray(value.bonusWallets) ? value.bonusWallets : []).find((w) => w.currency === wallet.currency)
    return {
      id: 'deepseek', label: 'DeepSeek', kind: 'balance', status: 'ready',
      amount: Number(wallet.balance), currency: wallet.currency, bonus: Number(bonus?.balance ?? 0) || 0,
    }
  } catch { return unavailable }
}

async function codexProvider() {
  const token = await codexToken()
  if (token === null) {
    return { id: 'codex', label: 'Codex', kind: 'usage', status: 'login-required', hint: '请先在终端执行 codex login' }
  }
  try {
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' }
    if (tokenCache.accountId !== '') headers['chatgpt-account-id'] = tokenCache.accountId
    const response = await fetch(USAGE_URL, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (response.status === 401) {
      return { id: 'codex', label: 'Codex', kind: 'usage', status: 'login-required', hint: 'Codex 登录已过期，请重新 codex login' }
    }
    if (!response.ok) throw new Error('usage request failed')
    const body = await response.json()
    const windows = parseUsage(body)
    if (windows.length === 0) throw new Error('no usage windows')
    return {
      id: 'codex',
      label: 'Codex',
      kind: 'usage',
      status: 'ready',
      plan: typeof body?.plan_type === 'string' && body.plan_type !== '' ? body.plan_type : 'subscription',
      windows,
    }
  } catch {
    return { id: 'codex', label: 'Codex', kind: 'usage', status: 'unavailable', hint: '暂时无法读取 Codex 额度' }
  }
}

async function manualProviders() {
  let config
  try {
    config = JSON.parse(await readFile(manualFile(), 'utf8'))
  } catch {
    return []
  }
  const list = Array.isArray(config?.providers) ? config.providers : []
  const rows = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue
    const id = entry.id.trim()
    if (id === '' || id === 'deepseek' || id === 'codex' || id === 'trae') continue
    const label = typeof entry.label === 'string' && entry.label !== '' ? entry.label : id
    if (Number.isFinite(Number(entry.remainingPercent))) {
      const percent = clampPercent(entry.remainingPercent)
      rows.push({
        id,
        label,
        kind: 'manual',
        status: 'ready',
        percent,
        remainingPercent: percent,
        resetsAt: typeof entry.resetsAt === 'string' ? entry.resetsAt : undefined,
        note: typeof entry.note === 'string' ? entry.note : '手动配置',
      })
    } else if (Number.isFinite(Number(entry.amount))) {
      rows.push({
        id,
        label,
        kind: 'manual',
        status: 'ready',
        amount: Number(entry.amount),
        currency: typeof entry.currency === 'string' ? entry.currency : 'CNY',
        note: typeof entry.note === 'string' ? entry.note : '手动配置',
      })
    }
  }
  return rows
}


const VOLC_AFP_ID = 'volcengine-afp'
const VOLC_CASH_ID = 'volcengine-cash'
const VOLC_WINDOWS = [
  ['AFPFiveHour', '5 小时'],
  ['AFPDaily', '今天'],
  ['AFPWeekly', '本周'],
  ['AFPMonthly', '本月'],
]

async function runVolcCli(args, timeout = 12_000) {
  const binary = process.env.VOLCENGINE_CLI || 've'
  const { stdout } = await execFile(binary, args, {
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  })
  return JSON.parse(stdout)
}

async function volcengineAfp() {
  try {
    const json = await runVolcCli(['ark', 'GetAFPUsage', '--force', '--version', '2024-01-01', '--method', 'POST', '--output', 'json'])
    const result = json?.Result
    if (result === undefined || result === null) throw new Error('empty AFP response')
    const windows = []
    for (const [key, label] of VOLC_WINDOWS) {
      const item = result[key]
      const quota = Number(item?.Quota)
      const used = Number(item?.Used)
      if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(used)) continue
      const remainingPercent = clampPercent(100 - (used / quota) * 100)
      const reset = Number(item?.ResetTime)
      windows.push({
        id: key.replace(/^AFP/, '').toLowerCase(),
        label,
        usedPercent: clampPercent((used / quota) * 100),
        remainingPercent,
        ...(Number.isFinite(reset) && reset > 0 ? { resetsAt: new Date(reset).toISOString() } : {}),
      })
    }
    if (windows.length === 0) throw new Error('no AFP windows')
    return {
      id: VOLC_AFP_ID,
      label: '火山方舟',
      kind: 'usage',
      status: 'ready',
      plan: typeof result.PlanType === 'string' ? result.PlanType : undefined,
      windows,
      note: 'Agent Plan AFP · 本机 ve 登录',
    }
  } catch {
    return {
      id: VOLC_AFP_ID,
      label: '火山方舟',
      kind: 'usage',
      status: 'unavailable',
      hint: '需要本机 ve 已登录；AFP 额度读取失败',
    }
  }
}

async function volcengineCash() {
  try {
    const json = await runVolcCli(['billing', 'QueryBalanceAcct', '--force', '--version', '2022-01-01', '--method', 'POST', '--output', 'json'])
    const result = json?.Result
    const amount = Number(result?.AvailableBalance)
    if (!Number.isFinite(amount)) throw new Error('empty balance')
    return {
      id: VOLC_CASH_ID,
      label: '火山账户',
      kind: 'balance',
      status: 'ready',
      amount,
      currency: typeof result.Currency === 'string' ? result.Currency : 'CNY',
      note: '火山引擎现金余额',
    }
  } catch {
    return {
      id: VOLC_CASH_ID,
      label: '火山账户',
      kind: 'balance',
      status: 'unavailable',
      hint: '需要本机 ve 已登录；现金余额读取失败',
    }
  }
}

const PLAN_LABELS = {
  lobehub: 'LobeHub',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  moonshotai: 'Kimi',
  zai: 'GLM',
  xai: 'Grok',
  huoshan: '火山模型',
}

async function dynamicPlans(llm) {
  if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') return []
  let providers
  try { providers = llm.listProviders() } catch { return [] }
  if (!Array.isArray(providers)) return []
  const rows = []
  for (const entry of providers) {
    const provider = typeof entry === 'string' ? entry : entry?.id
    if (typeof provider !== 'string' || provider === '') continue
    if (/^deepseek/i.test(provider) || /codex/i.test(provider)) continue
    let models = []
    try { models = await llm.listModels(provider) } catch { models = [] }
    if (!Array.isArray(models)) models = []
    const ready = models.length > 0
    rows.push({
      id: 'plan:' + provider,
      label: PLAN_LABELS[provider] ?? provider,
      kind: 'plan',
      status: ready ? 'ready' : 'unavailable',
      provider,
      modelCount: models.length,
      models: models.map((model) => model?.name || model?.id).filter(Boolean).slice(0, 6),
      note: ready ? '模型列表 · ' + models.length + ' 个模型' : '模型列表为空',
      hint: ready ? undefined : '模型列表暂不可用',
    })
  }
  return rows
}

async function providerSnapshot(account, llm) {
  const now = Date.now()
  if (usageCache.value !== null && now - usageCache.at < CACHE_MS) return usageCache.value
  const [deepseek, codex, volcAfp, volcCash, manual, plans] = await Promise.all([deepseekProvider(account), codexProvider(), volcengineAfp(), volcengineCash(), manualProviders(), dynamicPlans(llm)])
  const value = { at: new Date().toISOString(), deepseek, codex, volcAfp, volcCash, plans, manual: manual.filter((row) => row.id !== 'trae') }
  usageCache = { at: now, value }
  return value
}

export function apply(ctx) {
  ctx.inject(['webServer', 'llm'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }))
          return
        }
        try {
          const snapshot = await providerSnapshot(ctx.get('deepseekAccount'), scope.llm)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify({ ok: true, at: snapshot.at, providers: [snapshot.deepseek, snapshot.codex, snapshot.volcAfp, snapshot.volcCash, ...snapshot.plans, ...snapshot.manual] }))
        } catch {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, at: new Date().toISOString(), providers: [] }))
        }
      },
    }), 'dsh-account-ring: providers route')
  })
}
