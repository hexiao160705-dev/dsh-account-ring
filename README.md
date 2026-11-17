# dsh-account-ring

A multi-provider **balance / quota ring** for DeepSeek Harness (DSH). It sits beside Settings in the sidebar foot:

- Ring defaults to **DeepSeek official balance** (read through the signed-in DSH account, no API key needed)
- Click the ring for per-provider details
- Choose another provider as the ring's primary display
- Ignore a provider's warning (for tools you no longer use)
- **Codex** plan usage (5-hour / weekly windows) is read from the local `codex` login
- Coding plans already configured in DSH appear automatically from the model list
- Additional tools can be added as **manual** rows in `~/.dsh/account-ring.json`

## Privacy / desensitization

- The browser receives only display fields: provider label, amount or percentage, reset time, and a status word.
- Codex access tokens, account ids, emails, and raw usage payloads stay in the host half and are never returned by the route.
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

### LobeHub and other coding plans

The host reads the live DSH model catalog through `ctx.llm.listProviders()` + `listModels()`. Every configured provider with at least one model gets a **plan** row automatically; when a provider is added or removed from the model list, the row appears or disappears on the next refresh (30 seconds).

- A plan row shows its model count and up to six model names.
- Plans without a public balance API still work as a display/selection row; they do not invent a percentage.
- LobeHub is labeled `LobeHub`; other known providers have friendly labels, unknown ones use the provider id.
- LobeHub's OpenAI-compatible endpoint exposes models, not account credit balance; its row reports the live model count instead of a currency amount. A real balance needs a LobeHub account API endpoint, which this plugin will not invent.
- Removed providers (including old Trae entries) are not shown.

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
