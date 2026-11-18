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

async function lobehubQuota(credentials) {
  try {
    let key = process.env.LOBEHUB_API_KEY
    if ((key === undefined || key === '') && credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve('LOBEHUB_API_KEY')
      if (hit !== undefined && typeof hit.value === 'string') key = hit.value
    }
    if (typeof key !== 'string' || key === '') return null
    const response = await fetch('https://app.lobehub.com/api/v1/usage', {
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return null
    const json = await response.json()
    const quota = json?.data?.quota
    const limit = Number(quota?.limit)
    const remaining = Number(quota?.remaining)
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return null
    const resetsAt = typeof quota?.resetsAt === 'string' ? quota.resetsAt : undefined
    return {
      remainingPercent: clampPercent((remaining / limit) * 100),
      usedPercent: clampPercent(100 - (remaining / limit) * 100),
      amount: Number.isFinite(Number(json?.data?.remainingBalance)) ? Number(json.data.remainingBalance) : remaining,
      currency: typeof json?.data?.currency === 'string' ? json.data.currency : 'USD',
      limit,
      remaining,
      resetsAt,
    }
  } catch {
    return null
  }
}

const PROVIDER_LABELS = {
  deepseek: 'DeepSeek',
  codex: 'Codex',
  volcengine: '火山方舟',
  lobehub: 'LobeHub',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
}
const PROVIDER_ORDER = { deepseek: 0, codex: 1, volcengine: 2, lobehub: 3 }
const WINDOW_LABELS = { '7 days': '每周', '5 hours': '5 小时', '1 day': '今天', Credits: '额度', Credit: '额度' }
const HIDDEN_PROVIDERS = new Set(['trae', 'trae-cn', 'trae-global'])
const MAGPIE_BASE = String(process.env.MAGPIE_BASE_URL || 'http://127.0.0.1:3425').replace(/\/+$/, '')

async function fetchMagpieQuotas() {
  try {
    const response = await fetch(`${MAGPIE_BASE}/v1/magpie/quotas`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return null
    const json = await response.json()
    return Array.isArray(json?.data) ? json.data : null
  } catch {
    return null
  }
}

function maskAccount(value) {
  if (typeof value !== 'string' || value === '') return ''
  const at = value.indexOf('@')
  if (at > 0) return `${value.slice(0, 3)}***${value.slice(at)}`
  return value
}

function moneyOf(text) {
  const matches = [...String(text).matchAll(/[¥￥$€]\s*([0-9]+(?:\.[0-9]+)?)/gu)]
  if (matches.length === 0) return null
  const symbol = matches[0][0].trim().charAt(0)
  const currency = symbol === '$' ? 'USD' : symbol === '€' ? 'EUR' : 'CNY'
  return { amount: Number(matches[0][1]), currency }
}

function magpieWindows(item) {
  const windows = Array.isArray(item?.windows) ? item.windows : []
  const mapped = []
  for (const window of windows) {
    if (window === null || typeof window !== 'object') continue
    if (typeof window.display === 'string' && window.display === 'Unknown') continue
    const remaining = Number(window.remaining)
    if (!Number.isFinite(remaining)) continue
    const used = Number(window.used)
    const slug = String(window.name ?? mapped.length).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
    const rawLabel = typeof window.name === 'string' && window.name !== '' ? window.name : '额度'
    mapped.push({
      id: slug === '' ? `window-${mapped.length}` : slug,
      label: WINDOW_LABELS[rawLabel] ?? rawLabel,
      remainingPercent: clampPercent(remaining),
      usedPercent: Number.isFinite(used) ? clampPercent(used) : clampPercent(100 - remaining),
      ...(typeof window.resetsAt === 'string' ? { resetsAt: window.resetsAt } : {}),
    })
  }
  return mapped
}

function magpieRowOf(item) {
  const provider = String(item?.provider ?? '')
  if (provider === '' || HIDDEN_PROVIDERS.has(provider)) return null
  const account = maskAccount(item?.user)
  const label = PROVIDER_LABELS[provider] ?? (typeof item?.name === 'string' && item.name !== '' ? item.name : provider)
  const baseId = `magpie:${provider}:${account || 'default'}`

  if (typeof item?.balance === 'string' && item.balance !== '') {
    const money = moneyOf(item.balance)
    if (money === null) return null
    return {
      id: baseId,
      provider,
      account,
      label,
      kind: 'balance',
      status: 'ready',
      amount: money.amount,
      currency: money.currency,
      note: [account, item.balance].filter(Boolean).join(' · '),
    }
  }

  const windows = magpieWindows(item)
  if (windows.length === 0) {
    return {
      id: baseId,
      provider,
      label,
      kind: 'usage',
      status: 'unavailable',
      hint: typeof item?.error === 'string' && item.error !== '' ? item.error.slice(0, 160) : 'Magpie 没有返回额度窗口',
    }
  }
  return {
    id: baseId,
    provider,
    account,
    label,
    kind: 'usage',
    status: 'ready',
    plan: typeof item?.plan === 'string' && item.plan !== '' ? item.plan : undefined,
    windows,
    note: [account, 'Magpie'].filter(Boolean).join(' · '),
  }
}

function lobehubRow(quota) {
  if (quota === null) return null
  const symbol = quota.currency === 'USD' ? '$' : '¥'
  return {
    id: 'lobehub',
    provider: 'lobehub',
    label: 'LobeHub',
    kind: 'usage',
    status: 'ready',
    windows: [{
      id: 'quota',
      label: '额度',
      remainingPercent: quota.remainingPercent,
      usedPercent: quota.usedPercent,
      ...(quota.resetsAt === undefined ? {} : { resetsAt: quota.resetsAt }),
    }],
    note: '余额 ' + symbol + quota.amount.toFixed(2) + ' / ' + symbol + quota.limit.toFixed(2),
  }
}

async function providerSnapshot(account, credentials) {
  const now = Date.now()
  if (usageCache.value !== null && now - usageCache.at < CACHE_MS) return usageCache.value

  const [quotas, deepseekOwn, codexOwn, volcAfp, volcCash, lobe, manual] = await Promise.all([
    fetchMagpieQuotas(),
    deepseekProvider(account),
    codexProvider(),
    volcengineAfp(),
    volcengineCash(),
    lobehubQuota(credentials),
    manualProviders(),
  ])

  const rows = []
  const seen = new Set()
  const magpieRows = []

  for (const item of quotas ?? []) {
    const row = magpieRowOf(item)
    if (row === null) continue
    if (row.provider === 'volcengine' && row.status !== 'ready') continue
    magpieRows.push(row)
  }

  // The ring's primary slot keeps showing the wallet the signed-in DSH account uses,
  // so a Magpie read does not make the displayed number jump to another account.
  const deepseekRows = magpieRows.filter((row) => row.provider === 'deepseek')
  if (deepseekRows.length > 0) {
    const local = Number(deepseekOwn?.amount)
    const main = (Number.isFinite(local) ? deepseekRows.find((row) => Number.isFinite(row.amount) && Math.abs(row.amount - local) < 0.02) : undefined) ?? deepseekRows[0]
    magpieRows.sort((a, b) => {
      const left = PROVIDER_ORDER[a.provider] ?? 9
      const right = PROVIDER_ORDER[b.provider] ?? 9
      if (left !== right) return left - right
      if (a.provider === 'deepseek' && b.provider === 'deepseek') {
        if (a === main) return -1
        if (b === main) return 1
      }
      return 0
    })
    let position = 0
    for (const row of deepseekRows) {
      position += 1
      row.id = row === main ? 'deepseek' : `deepseek:${position}`
      // Two wallets with the same label would be indistinguishable in the list.
      if (row !== main && typeof row.account === 'string' && row.account !== '') row.label = `${row.label} · ${row.account}`
    }
  }

  for (const row of magpieRows) {
    if (row.provider === 'codex') row.id = 'codex'
    else if (row.provider === 'volcengine') row.id = 'volcengine'
    seen.add(row.provider)
    rows.push(row)
  }

  if (!seen.has('deepseek')) rows.push({ ...deepseekOwn, provider: 'deepseek' })
  if (!seen.has('codex')) rows.push({ ...codexOwn, provider: 'codex' })
  if (!seen.has('volcengine')) {
    rows.push({ ...volcAfp, provider: 'volcengine' })
    rows.push({ ...volcCash, provider: 'volcengine' })
  }
  const lobeRow = lobehubRow(lobe)
  if (lobeRow !== null && !seen.has('lobehub')) rows.push(lobeRow)
  for (const row of manual) rows.push({ ...row, provider: 'manual' })

  const providers = rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const a = PROVIDER_ORDER[left.row.provider] ?? 9
      const b = PROVIDER_ORDER[right.row.provider] ?? 9
      return a === b ? left.index - right.index : a - b
    })
    .map(({ row }) => {
      const cleaned = { ...row }
      delete cleaned.provider
      delete cleaned.account
      return cleaned
    })

  const value = { at: new Date().toISOString(), providers, source: quotas === null ? 'fallback' : 'magpie' }
  usageCache = { at: now, value }
  return value
}

export function apply(ctx) {
  ctx.inject(['webServer', 'credentials'], (scope) => {
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
          const snapshot = await providerSnapshot(ctx.get('deepseekAccount'), scope.credentials)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify({ ok: true, at: snapshot.at, source: snapshot.source, providers: snapshot.providers }))
        } catch {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, at: new Date().toISOString(), source: 'error', providers: [] }))
        }
      },
    }), 'dsh-account-ring: providers route')
  })
}
