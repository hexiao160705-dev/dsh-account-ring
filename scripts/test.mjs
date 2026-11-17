// Host route regression: DeepSeek wallets and Codex usage normalization.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = await mkdtemp(join(tmpdir(), 'dsh-account-ring-'))
process.env.DSH_HOME = join(home, 'dsh')
process.env.CODEX_HOME = join(home, 'codex')
await mkdir(process.env.CODEX_HOME, { recursive: true })
await writeFile(join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({
  tokens: { access_token: 'test-access', refresh_token: 'test-refresh', account_id: 'acct-test', expires_at: 4102444800 },
}))

const usage = {
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1794900000 },
    secondary_window: { used_percent: 53, limit_window_seconds: 604800, reset_at: 1794900000 },
  },
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => usage })

const account = {
  getBalance: async () => ({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '93.10' }],
    bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
  }),
}

let route
const ctx = {
  get(name) { return name === 'deepseekAccount' ? account : undefined },
  inject(_deps, setup) {
    setup({
      effect(fn) { fn(); return () => {} },
      webServer: { register(value) { route = value; return () => {} } },
      llm: {
        listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek Account' }, { id: 'lobehub', name: 'lobehub' }],
        listModels: async (provider) => provider === 'lobehub'
          ? [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }]
          : [],
      },
    })
  },
}

const { apply } = await import(pathToFileURL(resolve('index.js')).href)
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
const json = JSON.parse(response.body)
const deepseek = json.providers.find((row) => row.id === 'deepseek')
const codex = json.providers.find((row) => row.id === 'codex')
if (deepseek?.amount !== 93.1) throw new Error('deepseek amount not normalized')
if (deepseek?.bonus !== 5) throw new Error('deepseek bonus not normalized')
if (codex?.status !== 'ready' || codex?.plan !== 'pro') throw new Error('codex row not ready')
const weekly = codex.windows.find((window) => window.id === 'weekly')
if (weekly?.remainingPercent !== 47) throw new Error('weekly percent not normalized')
const plan = json.providers.find((row) => row.id === 'plan:lobehub')
if (plan?.kind !== 'plan' || plan?.modelCount !== 1) throw new Error('dynamic plan row not normalized')
if (plan?.label !== 'LobeHub') throw new Error('plan label not normalized')
if (json.providers.some((row) => row.id === 'trae')) throw new Error('trae must not be listed')
if (JSON.stringify(json).includes('test-access') || JSON.stringify(json).includes('acct-test')) {
  throw new Error('route leaked credential fields')
}
console.log('account ring route: ok')
