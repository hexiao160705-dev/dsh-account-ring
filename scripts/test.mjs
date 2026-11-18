// Route regression: Magpie quotas as the primary source, local readers as fallback.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = await mkdtemp(join(tmpdir(), 'dsh-account-ring-'))
process.env.DSH_HOME = join(home, 'dsh')
process.env.CODEX_HOME = join(home, 'codex')
// Never reach a real Volcengine CLI during tests.
process.env.VOLCENGINE_CLI = join(home, 'no-such-ve')
await mkdir(process.env.CODEX_HOME, { recursive: true })
await writeFile(join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({
  tokens: { access_token: 'test-access', refresh_token: 'test-refresh', account_id: 'acct-test', expires_at: 4102444800 },
}))

const codexUsage = {
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1794900000 },
    secondary_window: { used_percent: 53, limit_window_seconds: 604800, reset_at: 1794900000 },
  },
}

const magpieQuotas = {
  data: [
    {
      provider: 'codex',
      name: 'Codex',
      kind: 'subscription',
      plan: 'prolite',
      user: 'test-user@example.com',
      windows: [
        { name: '7 days', used: 100, remaining: 0, resetsAt: '2026-11-18T18:48:38+08:00' },
        { name: 'Image generation', used: 0, remaining: 100, display: 'Unknown', text: true },
      ],
    },
    {
      provider: 'trae-cn',
      name: 'Trae CN',
      kind: 'subscription',
      plan: 'Credits',
      windows: [{ name: 'Credits', used: 98.6, remaining: 1.4, resetsAt: '2026-12-14T15:57:45Z' }],
    },
    {
      provider: 'volcengine',
      name: 'Volcengine Ark',
      kind: 'plan',
      plan: 'Agent Plan',
      windows: [],
      error: 'this plan needs an access key',
    },
    { provider: 'deepseek', name: 'DeepSeek', kind: 'balance', user: 'Overseas', balance: '¥64.31 · $0.00' },
    { provider: 'deepseek', name: 'DeepSeek', kind: 'balance', user: 'sk-8…6785', balance: '¥31.54' },
  ],
  object: 'list',
}

const lobeUsage = {
  success: true,
  data: { quota: { limit: 15.5, remaining: 0.543728, usedRatio: 0.96, resetsAt: '2026-11-18T07:34:36.000Z' }, remainingBalance: 0.543728, currency: 'USD' },
}

function accountWith(balance) {
  return {
    getBalance: async () => ({
      status: 'ready',
      value: [{ currency: 'CNY', balance }],
      bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
    }),
  }
}

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body })

function pickFetch(magpieUp) {
  return async (url) => {
    const target = String(url)
    if (target.includes('/v1/magpie/quotas')) {
      if (!magpieUp) throw new Error('magpie is not running')
      return jsonResponse(magpieQuotas)
    }
    if (target.includes('app.lobehub.com')) return jsonResponse(lobeUsage)
    if (target.includes('wham/usage')) return jsonResponse(codexUsage)
    throw new Error('unexpected fetch ' + target)
  }
}

async function readProviders(magpieUp, cacheBust, balance) {
  globalThis.fetch = pickFetch(magpieUp)
  const account = accountWith(balance)
  let route
  const ctx = {
    get(name) { return name === 'deepseekAccount' ? account : undefined },
    inject(_deps, setup) {
      setup({
        effect(fn) { fn(); return () => {} },
        webServer: { register(value) { route = value; return () => {} } },
        credentials: {
          async resolve(name) { return name === 'LOBEHUB_API_KEY' ? { value: 'test-lobe-key', source: 'stored' } : undefined },
          async describe() { return { configured: true, writable: true } },
        },
      })
    },
  }
  const { apply } = await import(pathToFileURL(resolve('index.js')).href + (cacheBust ? '?scenario=fallback' : ''))
  apply(ctx)
  if (route === undefined) throw new Error('route was not registered')

  const response = await new Promise((resolveResponse) => {
    let status = 0
    let body = ''
    route.handler({ method: 'GET', headers: { host: '127.0.0.1:1' } }, {
      writeHead(code) { status = code },
      end(value) { body = value; resolveResponse({ status, body }) },
    })
  })
  if (response.status !== 200) throw new Error('unexpected status ' + response.status)
  return JSON.parse(response.body)
}

const magpieBody = await readProviders(true, false, '31.54')
if (magpieBody.source !== 'magpie') throw new Error('expected Magpie to be the source')
const rows = magpieBody.providers
const find = (id) => rows.find((row) => row.id === id)

const deepseekPrimary = find('deepseek')
if (deepseekPrimary?.amount !== 31.54) throw new Error('primary wallet should follow the signed-in DSH account')
const deepseekSecond = rows.find((row) => row.kind === 'balance' && row.amount === 64.31)
if (deepseekSecond === undefined) throw new Error('second deepseek wallet not listed')
if (!String(deepseekSecond.note).includes('Overseas')) throw new Error('second wallet account note missing')
if (!String(deepseekSecond.label).includes('Overseas')) throw new Error('second wallet label should name its account')

const codex = find('codex')
if (codex?.status !== 'ready' || codex?.plan !== 'prolite') throw new Error('codex row not ready')
if (codex.windows.length !== 1) throw new Error('codex should keep only the 7-day window')
if (codex.windows[0].remainingPercent !== 0) throw new Error('codex remaining percent not normalized')

if (rows.some((row) => /trae/i.test(String(row.label)) || String(row.id).includes('trae'))) {
  throw new Error('trae must not be listed')
}

const volc = rows.filter((row) => row.id === 'volcengine-afp' || row.id === 'volcengine-cash')
if (volc.length !== 2) throw new Error('volcengine rows should fall back to the local reader')

const lobe = find('lobehub')
if (lobe?.status !== 'ready' || lobe.windows[0].remainingPercent !== 4) throw new Error('lobehub quota not normalized')
if (!String(lobe.note).includes('$0.54')) throw new Error('lobehub balance not shown')

if (!rows.every((row) => row.provider === undefined)) throw new Error('internal provider field leaked to the page')
if (JSON.stringify(magpieBody).includes('test-user@example.com')) throw new Error('account identifier leaked')
if (!JSON.stringify(magpieBody).includes('tes***@example.com')) throw new Error('masked account missing')
if (JSON.stringify(magpieBody).includes('test-access') || JSON.stringify(magpieBody).includes('acct-test')) {
throw new Error('route leaked credential fields')
}

const fallbackBody = await readProviders(false, true, '93.10')
if (fallbackBody.source !== 'fallback') throw new Error('expected the local fallback when Magpie is down')
const ownDeepSeek = fallbackBody.providers.find((row) => row.id === 'deepseek')
if (ownDeepSeek?.amount !== 93.1 || ownDeepSeek?.bonus !== 5) throw new Error('fallback deepseek balance not normalized')
const ownCodex = fallbackBody.providers.find((row) => row.id === 'codex')
const weekly = ownCodex?.windows.find((window) => window.id === 'weekly')
if (weekly?.remainingPercent !== 47) throw new Error('fallback codex weekly percent not normalized')
if (fallbackBody.providers.find((row) => row.id === 'lobehub')?.status !== 'ready') throw new Error('lobehub row missing in fallback')

console.log('account ring route: ok')
