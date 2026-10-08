/**
 * Host half of the DeepSeek balance bundle.
 *
 * It reads the DeepSeek **platform account balance** — the recharge wallet and
 * the separate bonus wallet — and publishes it three ways: a `deepseek_balance`
 * agent tool, a same-origin JSON route the Client half polls for its composer
 * strip and settings page, and nothing else (no prompt notice; this bundle is
 * display-only by design).
 *
 * ## Which credential, and why not an API key
 *
 * The Harness signs in to platform.deepseek.com through the system browser and
 * stores a **session grant** in the local credential store. That grant is NOT an
 * `sk-` inference key: the balance endpoint accepts it only in the
 * `x-dsh-auth-token` header, and rejects `Authorization: Bearer <grant>` with
 * business code 40003. So this plugin reads the grant from the credential store
 * and speaks the platform's own protocol:
 *
 *   GET https://platform.deepseek.com/api/v0/users/get_user_summary
 *   x-dsh-auth-token: <grant>
 *
 * The endpoint is the one the DeepSeek web console reads for its wallet display.
 *
 * ## Notes carried over from the Harness account provider
 *
 * - Recharge balance (`normal_wallets`) and promotional credit (`bonus_wallets`)
 *   are deliberately kept apart; they are never summed.
 * - Balance strings are big.js-compatible numeric grammar (`0E-16`, trailing
 *   zeros and all). The original string is preserved and only echoed for display;
 *   a malformed value is rejected rather than silently coerced to zero.
 * - A credential rejection (HTTP 401 or top-level code 40003) means the sign-in
 *   is gone; it is reported as such instead of being shown as a zero balance.
 *
 * No imports from Harness packages: the definition objects below are the exact
 * shapes `ctx.tools.register` and `ctx.webServer.register` consume.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Balance endpoint on the DeepSeek platform origin. */
const SUMMARY_PATH = '/api/v0/users/get_user_summary';
/** Default platform origin; overridable for loopback development. */
const DEFAULT_PLATFORM_ORIGIN = 'https://platform.deepseek.com';
/** Same-origin route for the Web page; outside `/plugins` so no bundle route can shadow it. */
const USAGE_PATH = '/deepseek-balance/balance.json';
/** Socket timeout for one balance request. */
const REQUEST_TIMEOUT_MS = 30000;
/** DeepSeek platform business code meaning "authorization invalid". */
const CODE_INVALID_AUTHORIZATION = 40003;

/** Default credential store: the Harness home, then the profile's grant record. */
const DEFAULT_CREDENTIALS_FILE = join(homedir(), '.dsh/.credentials.yaml');
/** Grant record key holding the platform session token. */
const GRANT_KEY = 'deepseek-account-platform/default';

/**
 * Read the platform grant out of the Harness credential store.
 *
 * The store is small, line-oriented YAML written by the Harness itself, so the
 * record is located by key and its `token:` field read without a YAML parser —
 * which keeps this bundle dependency-free. `token` values that contain YAML
 * metacharacters are quoted by the writer; both forms are handled.
 *
 * @param file - absolute path of the credentials file.
 * @returns the grant token.
 * @throws when the file is unreadable or carries no grant.
 */
async function readGrant(file) {
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n');

  /** Strip an optional matching pair of YAML quotes from a scalar. */
  const unquote = (raw) => {
    const value = raw.trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if (first === last && (first === '"' || first === "'")) return value.slice(1, -1);
    }
    return value;
  };

  // Pass 1: locate the key and record the indentation of its own block.
  let recordIndent = null;
  let recordLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const leading = line.length - line.trimStart().length;
    if (trimmed === `${GRANT_KEY}:`) {
      recordIndent = leading;
      recordLine = index;
      break;
    }
  }
  if (recordLine === -1) {
    throw new Error(
      `no DeepSeek platform grant in ${file}. Sign in to the DeepSeek account in the Harness, or set config.authToken.`,
    );
  }

  // Pass 2: walk the record's block, descending only far enough to find `token`.
  // Sibling keys use the same or less indentation and end the search.
  for (let index = recordLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const leading = line.length - line.trimStart().length;
    if (leading <= recordIndent) break;
    const match = /^token:\s*(.*)$/.exec(trimmed);
    if (match === null) continue;
    const value = unquote(match[1]);
    if (value !== '') return value;
  }
  throw new Error(
    `the DeepSeek platform grant in ${file} carries no token. Sign in to the DeepSeek account in the Harness, or set config.authToken.`,
  );
}

/**
 * Resolve the grant from configuration first, then from the credential store.
 * @param config - resolved plugin configuration.
 * @returns the grant and where it came from.
 */
async function resolveGrant(config) {
  if (typeof config.authToken === 'string' && config.authToken !== '') {
    return { token: config.authToken, source: 'plugin config' };
  }
  const file = config.credentialsFile !== '' ? config.credentialsFile : DEFAULT_CREDENTIALS_FILE;
  try {
    return { token: await readGrant(file), source: file };
  } catch (error) {
    throw new Error(
      `could not read the DeepSeek platform grant from ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Accept a wallet amount the way the platform's own Web client does: the string
 * must parse as a finite decimal, and is echoed unchanged so no precision is
 * lost. `0E-16` and `5.0000000000000000` are both valid.
 * @param value - the raw balance string.
 * @returns the original string, or null when it is not a usable amount.
 */
function normalizeAmount(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
  return Number.isFinite(Number(text)) ? text : null;
}

/**
 * Normalize one platform wallet list into display rows.
 * @param wallets - the platform's wallet array.
 * @returns rows with a currency and a preserved amount string.
 */
function normalizeWallets(wallets) {
  if (!Array.isArray(wallets)) return [];
  const rows = [];
  for (const wallet of wallets) {
    if (wallet === null || typeof wallet !== 'object') continue;
    const amount = normalizeAmount(wallet.balance);
    if (amount === null) continue;
    rows.push({
      currency: typeof wallet.currency === 'string' && wallet.currency !== '' ? wallet.currency : '—',
      balance: amount,
    });
  }
  return rows;
}

/**
 * Resolve the plugin configuration against its defaults.
 * @param config - the row's config object.
 * @returns the usable configuration.
 */
function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const refreshSeconds =
    Number.isFinite(raw.refreshSeconds) && raw.refreshSeconds >= 30 ? raw.refreshSeconds : 300;
  const origin =
    typeof raw.platformOrigin === 'string' && raw.platformOrigin !== ''
      ? raw.platformOrigin.replace(/\/+$/, '')
      : DEFAULT_PLATFORM_ORIGIN;
  return {
    authToken: typeof raw.authToken === 'string' ? raw.authToken : '',
    credentialsFile: typeof raw.credentialsFile === 'string' ? raw.credentialsFile : '',
    platformOrigin: origin,
    refreshSeconds,
    /** The provider id whose selection shows the composer strip. */
    providerMatch:
      typeof raw.providerMatch === 'string' && raw.providerMatch !== ''
        ? raw.providerMatch
        : 'deepseek',
    /** Show the strip for every provider instead of only the matched one. */
    showForAllProviders: raw.showForAllProviders === true,
  };
}

/**
 * Fetch and normalize the current balance.
 * @param config - resolved plugin configuration.
 * @returns the wallets, spend totals, and the credential source.
 */
async function fetchBalance(config) {
  const { token, source } = await resolveGrant(config);
  const url = `${config.platformOrigin}${SUMMARY_PATH}`;
  const response = await fetch(url, {
    headers: {
      'x-dsh-auth-token': token,
      'x-client-platform': 'web',
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (response.status === 401) {
    throw new Error(
      'the DeepSeek sign-in was rejected (HTTP 401). Sign in again to refresh the account grant.',
    );
  }
  if (!response.ok) {
    throw new Error(`balance request failed: HTTP ${response.status}${text === '' ? '' : ` ${text.slice(0, 300)}`}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`balance response was not JSON: ${text.slice(0, 200)}`);
  }
  // The platform answers 200 with a business code for authorization failures.
  if (body !== null && typeof body === 'object' && body.code === CODE_INVALID_AUTHORIZATION) {
    throw new Error(
      `the DeepSeek sign-in was rejected (code ${CODE_INVALID_AUTHORIZATION}). Sign in again to refresh the account grant.`,
    );
  }
  if (body !== null && typeof body === 'object' && typeof body.code === 'number' && body.code !== 0) {
    const message = typeof body.msg === 'string' && body.msg !== '' ? body.msg : 'unknown platform error';
    throw new Error(`balance request refused: code ${body.code} ${message}`);
  }
  const data = body !== null && typeof body === 'object' && body.data !== null && typeof body.data === 'object' ? body.data : {};
  const biz =
    data.biz_data !== null && typeof data.biz_data === 'object' ? data.biz_data : data;
  const normalWallets = normalizeWallets(biz.normal_wallets);
  const bonusWallets = normalizeWallets(biz.bonus_wallets);
  const costs = Array.isArray(biz.total_costs)
    ? biz.total_costs
        .filter((entry) => entry !== null && typeof entry === 'object')
        .map((entry) => ({
          currency: typeof entry.currency === 'string' && entry.currency !== '' ? entry.currency : '—',
          amount: normalizeAmount(entry.amount) ?? '0',
        }))
    : [];
  if (normalWallets.length === 0 && bonusWallets.length === 0) {
    throw new Error('the balance response carried no wallets');
  }
  return { normalWallets, bonusWallets, costs, credentialSource: source, url };
}

/**
 * Format one amount for display, trimming the platform's excess precision while
 * keeping sub-cent accuracy (a balance of 9.9868016920 reads as 9.9868).
 * @param amount - the preserved amount string.
 * @returns a compact display string.
 */
function trimAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  const fixed = value.toFixed(4);
  return fixed.replace(/\.?0+$/, '') === '' ? '0' : fixed.replace(/\.?0+$/, '');
}

/**
 * Required service: the tool registry. `webServer` is optional and is looked up
 * lazily with `ctx.inject`, so the plugin still works without one.
 *
 * This export is load-bearing: without it Cordis activates the plugin
 * immediately, `ctx.tools` is undefined when `apply` runs, and the tool
 * registration below throws — which silently drops the tool *and* the route
 * registered after it.
 */
export const inject = ['tools'];

/**
 * Register the DeepSeek balance integration.
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the row's config object.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  /** Last successful reading; kept across failed refreshes so a blip never blanks the UI. */
  const state = { reading: null, fetchedAt: null, error: null, credentialSource: null, url: null };
  let inFlight = null;

  /**
   * Refresh the cached reading, collapsing concurrent callers onto one request.
   * @param force - fetch even when the cached reading is still fresh.
   * @returns the settled state.
   */
  const refresh = (force) => {
    const fresh =
      state.fetchedAt !== null && Date.now() - state.fetchedAt < config.refreshSeconds * 1000;
    if (inFlight !== null) return inFlight;
    if (fresh && force !== true) return Promise.resolve(state);
    inFlight = (async () => {
      try {
        const reading = await fetchBalance(config);
        state.reading = reading;
        state.fetchedAt = Date.now();
        state.credentialSource = reading.credentialSource;
        state.url = reading.url;
        state.error = null;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
      } finally {
        inFlight = null;
      }
      return state;
    })();
    return inFlight;
  };

  /**
   * Build the payload shared by the route and the tool.
   * @returns a JSON-safe snapshot.
   */
  const payload = () => {
    const reading = state.reading;
    const primary = reading === null ? null : (reading.normalWallets[0] ?? null);
    return {
      ok: reading !== null && state.error === null,
      stale: reading !== null && state.error !== null,
      fetchedAt: state.fetchedAt === null ? null : new Date(state.fetchedAt).toISOString(),
      credentialSource: state.credentialSource,
      source: state.url ?? `${config.platformOrigin}${SUMMARY_PATH}`,
      refreshSeconds: config.refreshSeconds,
      providerMatch: config.providerMatch,
      showForAllProviders: config.showForAllProviders,
      /** The recharge wallet, promoted for the compact strip. */
      balance: primary === null ? null : { currency: primary.currency, amount: primary.balance },
      normalWallets: reading === null ? [] : reading.normalWallets,
      bonusWallets: reading === null ? [] : reading.bonusWallets,
      costs: reading === null ? [] : reading.costs,
      error: state.error,
    };
  };

  /**
   * Render the reading as the compact text the agent reads.
   * @param snapshot - the payload.
   * @returns one line per wallet, plus spend totals and any failure.
   */
  const format = (snapshot) => {
    const lines = [];
    if (snapshot.ok !== true && snapshot.stale !== true) {
      lines.push('DeepSeek balance: no reading yet.');
    } else {
      const wallet = (row) => `${row.currency} ${trimAmount(row.balance)}`;
      const cost = (row) => `${row.currency} ${trimAmount(row.amount)}`;
      lines.push(
        `DeepSeek balance: ${snapshot.normalWallets.length === 0 ? 'n/a' : snapshot.normalWallets.map(wallet).join(', ')}`,
      );
      if (snapshot.bonusWallets.length > 0) {
        lines.push(`Bonus credit: ${snapshot.bonusWallets.map(wallet).join(', ')} (separate from the recharge balance)`);
      }
      if (snapshot.costs.length > 0) {
        lines.push(`Total spent: ${snapshot.costs.map(cost).join(', ')}`);
      }
    }
    if (snapshot.fetchedAt !== null) lines.push(`fetched ${snapshot.fetchedAt} from ${snapshot.source}`);
    if (snapshot.error !== null) lines.push(`last refresh failed: ${snapshot.error}`);
    return lines.join('\n');
  };

  // Poll in the background so the strip and the tool stay current.
  ctx.effect(() => {
    void refresh(false);
    const timer = setInterval(() => void refresh(false), config.refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, 'deepseek-balance: polling');

  // Agent tool: read the balance on demand.
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'deepseek_balance',
        description:
          'Read the remaining DeepSeek platform account balance: the recharge wallet and any separate bonus credit, plus total spent. Report it before starting an expensive run when the user asks how much credit is left.',
        parameters: {
          type: 'object',
          properties: {
            refresh: {
              type: 'boolean',
              description:
                'Force a fresh reading instead of the cached one (the cache lives for the configured refresh interval).',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [
            { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
          ],
        },
        async execute(args) {
          const requested = args !== null && typeof args === 'object' && args.refresh === true;
          await refresh(requested);
          return format(payload());
        },
        isConcurrencySafe: () => true,
      }),
    'deepseek-balance: tool',
  );

  // Same-origin route for the Web page. The browser cannot call the platform
  // itself, so the Host serves the reading on its own origin.
  ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed');
        return;
      }
      const url = new URL(req.url ?? USAGE_PATH, 'http://localhost');
      await refresh(url.searchParams.get('refresh') === '1');
      const body = JSON.stringify(payload(), null, 2);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: USAGE_PATH, handler }),
      'deepseek-balance: balance route',
    );
  });
}
