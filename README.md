# dsh-account-ring

A multi-provider **balance / quota ring** for DeepSeek Harness (DSH). It sits beside Settings in the sidebar foot:

- **Magpie is the primary source**: when `magpie` is running, balances and quotas come from its `/v1/magpie/quotas` endpoint
- Falls back to the local readers (DSH account, `~/.codex/auth.json`, `ve` CLI, LobeHub API) whenever Magpie is offline or a provider has no quota there
- Click the ring for per-provider details
- Choose another provider as the ring's primary display
- Ignore a provider's warning (for tools you no longer use)
- Additional tools can be added as **manual** rows in `~/.dsh/account-ring.json`

## Privacy / desensitization

- The browser receives only display fields: provider label, amount or percentage, reset time, and a status word.
- Account emails are masked before they reach the page (`hex***@gmail.com`); Codex access tokens, account ids, and raw usage payloads stay in the host half.
- The Magpie base URL can be changed with `MAGPIE_BASE_URL` (default `http://127.0.0.1:3425`).
- The plugin never writes to `~/.codex/auth.json`; a refreshed access token stays in host memory only.
- DeepSeek balance comes from the DSH account Remote (`ctx.remote.account.getBalance`), which already returns sanitized wallet amounts.

## Install

From GitHub:

```bash
dsh plugin --profile desktop add github:hexiao160705-dev/dsh-account-ring
```

Or from a checkout:

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-account-ring
```

Reload/restart DSH. The ring appears in the sidebar footer.

## Providers

### Magpie (primary)

When Magpie is running, every row it reports comes from `GET http://127.0.0.1:3425/v1/magpie/quotas`:

- `kind: balance` rows (`balance: "¥31.54"`) become currency rows.
- `kind: subscription` / `plan` rows with `windows` become percentage rows using each window's `remaining` value.
- Windows whose `display` is `Unknown` (for example Codex image generation) are skipped.
- Providers Magpie cannot read yet — Volcengine Agent Plan without an access key — fall through to the local reader below.

Trae is intentionally hidden. To show it again, remove `trae-cn` from `HIDDEN_PROVIDERS` in `index.js`.

DeepSeek can have several wallets. The one matching the signed-in DSH account keeps the plain `deepseek` id so the ring does not jump to another account; the others get `deepseek:2`, `deepseek:3` and a label naming their account.

### DeepSeek

Uses the signed-in DSH account. No `DEEPSEEK_API_KEY` is required. The ring shows the recharge wallet; details also show granted bonus when present.

### Volcengine / 火山方舟

The ring reads the **Agent Plan AFP quota** through the locally logged-in `ve` CLI:

```bash
ve ark GetAFPUsage --force --version 2024-01-01 --method POST --output json
```

It shows the 5-hour, daily, weekly and monthly AFP windows, plus the Volcengine cash balance (`ve billing QueryBalanceAcct`). Set `VOLCENGINE_CLI` if `ve` is not on `PATH`. Both rows are read-only; no AK/SK is stored by the plugin.

### Codex

Reads `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`), calls the ChatGPT usage endpoint, and normalizes the 5-hour and weekly windows. If the login expired it shows `请先在终端执行 codex login`; it never renders the token.

### LobeHub

`GET https://app.lobehub.com/api/v1/usage` with `LOBEHUB_API_KEY` is still read directly, because Magpie does not report LobeHub. The row shows the quota percentage, the remaining balance and the reset time.

### Manual tools

For a tool that is not a DSH model provider, add a manual entry to `~/.dsh/account-ring.json`:

```json
{
  "providers": [
    { "id": "some-api", "label": "Some API", "amount": 18.5, "currency": "CNY" }
  ]
}
```

Manual entries support `remainingPercent` or `amount` + `currency`.

## Warnings

- Usage / manual percentage: warning at ≤ 20% remaining, error at ≤ 10%.
- Balance: warning at ≤ ¥10, error at ≤ ¥5 (ring fill is scaled to ¥30 for a full circle).
- The bell button on a row ignores or restores that provider's warning. The setting is local to this browser profile.
- The `主` button makes a provider the ring's primary display; the choice persists in localStorage.

## Limitations

- The Codex usage endpoint is not a public contract and may change.
- The ring refreshes every 30 seconds while the page is visible; no polling while hidden.
- This plugin is local-first; it does not sync settings across browsers or machines.

## License

MIT
