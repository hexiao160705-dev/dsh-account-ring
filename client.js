// SPDX-License-Identifier: MIT
window.__ModuleLoader__.load({
  id: 'dsh-account-ring',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PKG = 'dsh-account-ring'
    const PRIMARY_KEY = PKG + '.primary'
    const IGNORED_KEY = PKG + '.ignored'
    const REFRESH_MS = 30_000

    const isZh = () => {
      try { return String(navigator.language || '').toLowerCase().startsWith('zh') } catch { return false }
    }
    const read = (key, fallback) => {
      try { return window.localStorage.getItem(key) ?? fallback } catch { return fallback }
    }
    const write = (key, value) => {
      try { window.localStorage.setItem(key, value) } catch { /* private mode */ }
    }
    const ignoredSet = () => {
      try {
        const parsed = JSON.parse(read(IGNORED_KEY, '[]'))
        return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [])
      } catch { return new Set() }
    }
    const formatMoney = (amount, currency) => {
      if (!Number.isFinite(amount)) return '—'
      const symbol = currency === 'USD' ? '$' : '¥'
      return symbol + amount.toFixed(amount >= 100 ? 0 : 2)
    }
    const formatReset = (value) => {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      try {
        return date.toLocaleString(isZh() ? 'zh-CN' : 'en-US', {
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
        })
      } catch { return '' }
    }

    async function readDeepSeek(ctx) {
      const zh = isZh()
      try {
        const accountUi = ctx.get('accountUi')
        const remote = ctx.remote?.account ?? ctx.get('remote')?.account
        const meta = accountUi?.clientMetadata?.(navigator.language || 'zh-CN')
        if (remote?.getBalance === undefined || meta === undefined) {
          return { id: 'deepseek', label: 'DeepSeek', kind: 'balance', status: 'unavailable', hint: zh ? '登录后可用' : 'Sign in to read the balance' }
        }
        const result = await remote.getBalance(meta)
        if (result?.ok !== true || result.value?.status !== 'ready') throw new Error('balance unavailable')
        const wallets = Array.isArray(result.value.value) ? result.value.value : []
        const wallet = wallets.find((w) => w.currency === 'CNY') ?? wallets[0]
        if (wallet === undefined) throw new Error('no wallet')
        const bonus = (Array.isArray(result.value.bonusWallets) ? result.value.bonusWallets : [])
          .find((w) => w.currency === wallet.currency)
        return {
          id: 'deepseek',
          label: 'DeepSeek',
          kind: 'balance',
          status: 'ready',
          amount: Number(wallet.balance),
          currency: wallet.currency,
          bonus: Number(bonus?.balance ?? 0) || 0,
        }
      } catch {
        return { id: 'deepseek', label: 'DeepSeek', kind: 'balance', status: 'unavailable', hint: zh ? '余额暂不可用' : 'Balance unavailable' }
      }
    }

    async function readHostProviders() {
      try {
        const response = await fetch('/dsh-account-ring/providers', { headers: { accept: 'application/json' }, cache: 'no-store' })
        if (!response.ok) return []
        const body = await response.json()
        return Array.isArray(body?.providers) ? body.providers : []
      } catch { return [] }
    }

    function warningOf(row, ignored) {
      if (row === undefined || row === null) return null
      if (ignored.has(row.id) || row.status !== 'ready') return null
      if (row.kind === 'usage' || row.kind === 'manual') {
        const percent = Number(row.kind === 'usage'
          ? (row.windows?.find((w) => w.id === 'weekly')?.remainingPercent ?? row.windows?.[0]?.remainingPercent)
          : row.remainingPercent)
        if (!Number.isFinite(percent)) return null
        if (percent <= 10) return 'error'
        if (percent <= 20) return 'warn'
        return null
      }
      if (Number.isFinite(row.amount)) {
        if (row.amount <= 5) return 'error'
        if (row.amount <= 10) return 'warn'
      }
      return null
    }

    function ringPercent(row) {
      if (row === undefined || row.status !== 'ready') return 0
      if (row.kind === 'usage') {
        return Number(row.windows?.find((w) => w.id === 'weekly')?.remainingPercent
          ?? row.windows?.[0]?.remainingPercent ?? 0)
      }
      if (row.kind === 'plan') return 100
      if (row.kind === 'manual') return Number(row.remainingPercent ?? row.percent ?? 0)
      if (Number.isFinite(row.amount)) return Math.min(100, Math.max(0, (row.amount / 30) * 100))
      return 0
    }

    function ringText(row, wide) {
      if (row === undefined || row.status !== 'ready') return wide ? '—' : '?'
      if (row.kind === 'balance') return wide ? formatMoney(row.amount, row.currency) : (row.currency === 'USD' ? '$' : '¥')
      if (row.kind === 'plan') { const n = Number(row.modelCount ?? row.models?.length ?? 0); return wide ? (n > 0 ? n + (zh ? ' 模型' : ' models') : 'ON') : 'ON' }
      const percent = Math.round(ringPercent(row))
      return wide ? percent + '%' : String(percent)
    }

    function Ring(props) {
      const { wide, ctx } = props
      const [rows, setRows] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [open, setOpen] = React.useState(false)
      const [primary, setPrimary] = React.useState(() => read(PRIMARY_KEY, 'deepseek'))
      const [ignored, setIgnored] = React.useState(ignoredSet)
      const panelRef = React.useRef(null)
      const rootRef = React.useRef(null)
      const zh = isZh()

      const refresh = React.useCallback(async () => {
        const host = await readHostProviders()
        const deepseek = host.some((row) => row.id === 'deepseek') ? null : await readDeepSeek(ctx)
        const next = deepseek === null ? host : [deepseek, ...host]
        setRows(next)
        setLoading(false)
        setPrimary((current) => (next.some((row) => row.id === current) ? current : (next[0]?.id ?? 'deepseek')))
      }, [])

      React.useEffect(() => {
        void refresh()
        const timer = window.setInterval(() => {
          if (document.visibilityState === 'visible') void refresh()
        }, REFRESH_MS)
        const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [refresh])

      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (rootRef.current?.contains(event.target) === true) return
          if (panelRef.current?.contains(event.target) === true) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const choosePrimary = (id) => {
        write(PRIMARY_KEY, id)
        setPrimary(id)
      }
      const toggleIgnored = (id) => {
        const next = new Set(ignored)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        write(IGNORED_KEY, JSON.stringify([...next]))
        setIgnored(next)
      }

      const primaryRow = rows.find((row) => row.id === primary) ?? rows[0]
      const percent = ringPercent(primaryRow)
      const tone = warningOf(primaryRow, ignored) === 'error'
        ? 'var(--dsw-alias-state-error-primary, #ef4444)'
        : warningOf(primaryRow, ignored) === 'warn'
          ? 'var(--dsw-alias-state-warning-primary, #f59e0b)'
          : 'var(--dsw-alias-state-success-primary, #22c55e)'
      const stroke = ignored.has(primaryRow?.id) ? 'var(--dsw-alias-label-tertiary, #9ca3af)' : tone
      const circumference = 2 * Math.PI * 10
      const dash = (Math.min(100, Math.max(1, percent)) / 100) * circumference

      return h('div', { ref: rootRef, style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h('button', {
          type: 'button',
          title: (zh ? '余额与额度' : 'Balance and quota') + (primaryRow?.label ? ' · ' + primaryRow.label : ''),
          'aria-label': zh ? '余额与额度' : 'Balance and quota',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 4px', border: 'none',
            background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer',
          },
        },
          h('svg', { width: 25, height: 25, viewBox: '0 0 24 24', 'aria-hidden': true, style: { flex: 'none' } },
            h('circle', { cx: 12, cy: 12, r: 10, fill: 'none', stroke: 'var(--dsw-alias-border-l1, rgba(127,127,127,.3))', strokeWidth: 2.5 }),
            h('circle', {
              cx: 12, cy: 12, r: 10, fill: 'none', stroke, strokeWidth: 2.5, strokeLinecap: 'round',
              strokeDasharray: dash + ' ' + circumference, transform: 'rotate(-90 12 12)',
            }),
            h('circle', { cx: 12, cy: 12, r: 3.2, fill: stroke }),
          ),
          wide ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, inherit)', whiteSpace: 'nowrap' } },
            loading && rows.length === 0 ? '…' : ringText(primaryRow, true)
          ) : null),
        open ? h('div', {
          ref: panelRef,
          role: 'dialog',
          'aria-label': zh ? '余额与额度明细' : 'Balance and quota details',
          style: {
            position: 'fixed', left: 8, bottom: 58, width: 342, maxHeight: '70vh', overflow: 'auto',
            zIndex: 60, padding: '12px 14px', borderRadius: 10,
            background: 'var(--dsw-alias-bg-l1, #fff)', color: 'var(--dsw-alias-label-primary, inherit)',
            border: '.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3))',
            boxShadow: '0 12px 32px rgba(0,0,0,.22)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingBottom: 8 } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, zh ? '余额与额度' : 'Balance and quota'),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('button', {
                type: 'button', onClick: () => { setLoading(true); void refresh() }, title: zh ? '刷新' : 'Refresh',
                style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 13 },
              }, '↻'),
              h('button', {
                type: 'button', onClick: () => setOpen(false), title: zh ? '关闭' : 'Close',
                style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 13 },
              }, '✕'))),
          rows.length === 0
            ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)', padding: '10px 0' } },
              loading ? (zh ? '读取中…' : 'Loading…') : (zh ? '暂无数据' : 'No data'))
            : rows.map((row) => {
              const warn = warningOf(row, ignored)
              const isIgnored = ignored.has(row.id)
              const dot = warn === 'error' ? '#ef4444' : warn === 'warn' ? '#f59e0b' : isIgnored ? '#9ca3af' : '#22c55e'
              const title = row.label + (row.plan ? ' · ' + row.plan : '')
              const value = row.kind === 'balance'
                ? formatMoney(row.amount, row.currency)
                : row.kind === 'usage'
                  ? Math.round(Number(row.windows?.find((w) => w.id === 'weekly')?.remainingPercent ?? row.windows?.[0]?.remainingPercent ?? 0)) + '%'
                  : row.kind === 'plan'
                    ? (Number(row.modelCount ?? row.models?.length ?? 0) > 0 ? String(row.modelCount ?? row.models?.length) + (zh ? ' 模型' : ' models') : 'ON')
                  : Number.isFinite(Number(row.amount))
                    ? formatMoney(Number(row.amount), row.currency)
                    : Math.round(Number(row.remainingPercent ?? row.percent ?? 0)) + '%'
              return h('div', {
                key: row.id,
                style: {
                  padding: '8px 0', borderTop: '.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))',
                  opacity: isIgnored ? .55 : 1,
                },
              },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: dot, flex: 'none' } }),
                  h('div', { style: { minWidth: 0, flex: 1 } },
                    h('div', { style: { fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
                    row.status !== 'ready'
                      ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, inherit)', marginTop: 2 } }, row.hint ?? (zh ? '不可用' : 'Unavailable'))
                      : null),
                  h('div', { style: { fontSize: 12, fontVariantNumeric: 'tabular-nums' } }, value),
                  h('button', {
                    type: 'button', title: zh ? '设为主显示' : 'Show in the ring', 'aria-label': zh ? '设为主显示' : 'Show in the ring',
                    onClick: () => choosePrimary(row.id),
                    style: {
                      width: 20, height: 20, borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 11,
                      background: primary === row.id ? 'var(--dsw-alias-state-success-primary, #22c55e)' : 'transparent',
                      color: primary === row.id ? '#fff' : 'var(--dsw-alias-label-tertiary, inherit)',
                    },
                  }, '主'),
                  h('button', {
                    type: 'button', title: isIgnored ? (zh ? '恢复预警' : 'Restore warning') : (zh ? '忽略预警' : 'Ignore warning'),
                    'aria-label': isIgnored ? (zh ? '恢复预警' : 'Restore warning') : (zh ? '忽略预警' : 'Ignore warning'),
                    onClick: () => toggleIgnored(row.id),
                    style: {
                      width: 20, height: 20, borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 11,
                      background: 'transparent', color: warn ? dot : 'var(--dsw-alias-label-tertiary, inherit)',
                    },
                  }, isIgnored ? '○' : warn ? '!' : '·')),
                row.kind === 'plan' && row.status === 'ready' && Array.isArray(row.models) && row.models.length > 0
                  ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, inherit)', paddingLeft: 15, marginTop: 2 } }, row.models.join(' · '))
                  : null,
                row.kind === 'usage' && row.status === 'ready'
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 15, marginTop: 3 } },
                    row.windows.map((window) => h('div', { key: window.id, style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, inherit)' } },
                      window.label + ' ' + (zh ? '剩余 ' : 'left ') + window.remainingPercent + '%'
                      + (formatReset(window.resetsAt) ? ' · ' + formatReset(window.resetsAt) : ''))))
                  : null,
                row.kind === 'balance' && row.status === 'ready' && row.bonus > 0
                  ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, inherit)', paddingLeft: 15, marginTop: 2 } },
                    (zh ? '含赠金 ' : 'bonus ') + formatMoney(row.bonus, row.currency))
                  : null,
                row.note ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, inherit)', paddingLeft: 15, marginTop: 2 } }, row.note) : null)
            }),
          h('div', { style: { paddingTop: 8, fontSize: 10.5, lineHeight: '15px', color: 'var(--dsw-alias-label-tertiary, inherit)', borderTop: '.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))' } },
            zh ? '仅本机显示；令牌与账号标识不会进入页面。' : 'Local display only; tokens and account identifiers never reach the page.')) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: PKG,
          order: 40,
        }, (props) => h(Ring, { ...props, ctx })))
      },
    }
  },
})
