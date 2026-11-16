# dsh-account-ring

A multi-provider **balance / quota ring** for DeepSeek Harness (DSH). It sits beside Settings in the sidebar foot:

- Ring defaults to **DeepSeek official balance** (read through the signed-in DSH account, no API key needed)
- Click the ring for per-provider details
- Choose another provider as the ring's primary display
- Ignore a provider's warning (for tools you no longer use, e.g. Trae)
- **Codex** plan usage (5-hour / weekly windows) is read from the local `codex` login
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

### Codex

Reads `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`), calls the ChatGPT usage endpoint, and normalizes the 5-hour and weekly windows. If the login expired it shows `请先在终端执行 codex login`; it never renders the token.

### Trae and other manual tools

Trae has no public balance API. Add a manual entry to `~/.dsh/account-ring.json`:

```json
{
  "providers": [
    { "id": "trae", "label": "Trae", "remainingPercent": 40, "note": "手动配置" },
    { "id": "some-api", "label": "Some API", "amount": 18.5, "currency": "CNY" }
  ]
}
```

The file is optional; without a `trae` entry the row shows as unsupported, and its warning can still be ignored.

## Warnings

- Usage / manual percentage: warning at ≤ 20% remaining, error at ≤ 10%.
- Balance: warning at ≤ ¥10, error at ≤ ¥5 (ring fill is scaled to ¥30 for a full circle).
- The bell button on a row ignores or restores that provider's warning. The setting is local to this browser profile.
- The `主` button makes a provider the ring's primary display; the choice persists in localStorage.

## Limitations

- Trae has no public quota endpoint; only manual values are supported.
- The Codex usage endpoint is not a public contract and may change.
- The ring refreshes every 60 seconds while the page is visible; no polling while hidden.
- This plugin is local-first; it does not sync settings across browsers or machines.

## License

MIT
