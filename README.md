# dsh-deepseek-balance

Remaining **DeepSeek platform balance** inside DeepSeek Harness: an ambient
readout under the composer, a settings page, and a `deepseek_balance` tool the
agent can call.

This is a **wallet**, not a quota. The number counts down as credit is spent,
so it answers "how much of my top-up is left?" — the question the OpenCode Go
usage meters cannot answer.

## What it gives you

| Surface | Behaviour |
|---|---|
| **Composer readout** | `DeepSeek balance USD 9.96` with total spend beside it, under the composer. Polls every 60s; goes amber below `$2` and red below `$0.50`. |
| **Model-aware visibility** | Shows while the session's selected model belongs to a DeepSeek provider (`deepseek-account` by default). Set `showForAllProviders: true` to always show it. |
| **Settings page** | *Settings → DeepSeek balance*: the remaining amount, the recharge wallet, bonus credit, and spend totals, plus the credential source, endpoint, and a manual **Refresh**. |
| **`deepseek_balance` tool** | The same reading as text, so the agent can report headroom before an expensive run. |
| **No prompt notice** | Display-only by design. Nothing is injected into the model's context. |

Recharge funds and promotional credit are shown in **separate** rows and are
never summed — the same distinction the DeepSeek platform itself makes.

## Requirements

- DeepSeek Harness with the Web UI.
- A **DeepSeek platform sign-in** in the Harness (Settings → Account). The
  plugin reuses that grant; it does not need an API key.

## Why not an API key

The Harness signs in to `platform.deepseek.com` and stores a **session grant**,
not an `sk-` inference key. The balance endpoint accepts that grant only in the
`x-dsh-auth-token` header; `Authorization: Bearer <grant>` is rejected with
business code `40003`. The plugin therefore reads the grant from the credential
store and speaks the platform's protocol:

```
GET https://platform.deepseek.com/api/v0/users/get_user_summary
x-dsh-auth-token: <grant>
```

```json
{
  "code": 0,
  "data": {
    "biz_data": {
      "normal_wallets": [{ "currency": "USD", "balance": "9.9605473720000000" }],
      "bonus_wallets":  [{ "currency": "USD", "balance": "0" }],
      "total_costs": [
        { "currency": "USD", "amount": "0.0394526280000000" },
        { "currency": "CNY", "amount": "6.0857838800000000" }
      ]
    }
  }
}
```

Balance strings are preserved exactly as sent and only rounded for display, so
no precision is lost.

## Install

**Web.** *Plugins* page → **Add plugin** → paste `@wasp/dsh-deepseek-balance`.

**From a checkout** (local development):

```jsonc
// ~/.dsh/profiles/<profile>/package.json
"dependencies": { "@wasp/dsh-deepseek-balance": "link:/path/to/deepseek-balance-plugin" },
"dsh": { "profile": { "bundles": [ /* … */ "@wasp/dsh-deepseek-balance" ] } }
```

Then apply the bundle's patch row to the profile's `cordis.yml` and restart the
Host. The Host serves the reading on `/deepseek-balance/balance.json`.

Installing runs the plugin **in-process with your permissions**.

## Configuration

Overridable in your profile patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: deepseek-balance
  name: '@wasp/dsh-deepseek-balance'
  config:
    refreshSeconds: 300
    providerMatch: 'deepseek'
```

| Key | Default | Meaning |
|---|---|---|
| `authToken` | `''` | Use this grant instead of reading the credential store. Prefer leaving it empty. |
| `credentialsFile` | `''` | Path to the Harness credential store. Empty means `~/.dsh/.credentials.yaml`. |
| `platformOrigin` | `https://platform.deepseek.com` | The account origin. |
| `refreshSeconds` | `300` | How often the Host re-reads the balance (minimum 30). |
| `providerMatch` | `'deepseek'` | The readout shows when the selected provider id contains this substring. |
| `showForAllProviders` | `false` | Show the readout regardless of the selected provider. |

## Privacy

- The grant is read from disk on each refresh and sent **only** to
  `platform.deepseek.com` as the `x-dsh-auth-token` header. It is never logged,
  cached to disk, or sent anywhere else.
- The local route exposes amounts, currencies, and the *path* the grant came
  from — never the grant itself.
- No telemetry, no analytics, no third-party requests.

## Failure behaviour

- A rejected sign-in (HTTP 401 or code `40003`) is reported as *"sign in again"*,
  never as a zero balance.
- A transport failure keeps the last good reading and marks it stale, so a blip
  does not blank the readout.
- A malformed amount is rejected rather than coerced to `0`.

## Development

The Host half can be exercised against the live endpoint without installing
anything:

```bash
node test-host.mjs
```

It drives `apply()` with a fake Cordis context and prints the tool output, the
route response, the method guard, and the failure path for a bad grant.

## License

MIT — see [LICENSE](LICENSE).
