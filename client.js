/**
 * Client half of the DeepSeek balance bundle.
 *
 * Two registrations, both fed by the Host's same-origin route (the browser
 * cannot call the DeepSeek platform directly):
 *  - `conversation.composer.dock`: the ambient balance readout under the composer.
 *  - `settings.section`: the DeepSeek balance page with the full reading.
 *
 * The composer readout shows the **remaining** balance — this is a wallet, not a
 * quota, so the number counts down as credit is spent.
 *
 * Plain React only: no Harness Client package is imported, so nothing here can
 * break when those packages change.
 */
window.__ModuleLoader__.load({
  id: '@wasp/dsh-deepseek-balance',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Client locale namespace and host route, both owned by this bundle. */
    const NS = 'deepseek-balance';
    const ENDPOINT = '/deepseek-balance/balance.json';
    /** Poll cadence. Each poll forces the Host to re-read upstream. */
    const POLL_MS = 60000;
    /** Age past which the reading is called out as lagging, so staleness is visible. */
    const LAG_MS = 180000;
    /** Remaining balance at or below which the readout turns amber / red. */
    const LOW_AMOUNT = 2;
    const CRITICAL_AMOUNT = 0.5;

    /** English copy. */
    const en = {
      title: 'DeepSeek balance',
      description:
        'Remaining DeepSeek platform credit: the recharge wallet and any separate bonus credit.',
      refresh: 'Refresh',
      loading: 'Loading balance…',
      unavailable: 'Balance unavailable',
      remaining: 'Remaining',
      wallet: 'Wallet',
      balance: 'Balance',
      updated: 'Updated',
      credential: 'Credential',
      endpoint: 'Endpoint',
      stale: 'Showing the last good reading; the latest refresh failed.',
      behind: 'behind',
      lastError: 'Last error',
      hint: 'The reading uses the DeepSeek sign-in grant the Harness already stored; it needs no API key.',
      signIn: 'Sign in again to refresh the DeepSeek account grant.',
      never: 'never',
      recharge: 'Recharge',
      promotional: 'Promotional credit',
    };

    /** Bulgarian copy, matching the deployment language. */
    const bg = {
      title: 'Баланс в DeepSeek',
      description:
        'Оставащ кредит в платформата DeepSeek: портфейлът за зареждане и отделният бонус кредит.',
      refresh: 'Обнови',
      loading: 'Зареждане на баланса…',
      unavailable: 'Балансът не е наличен',
      remaining: 'Остатък',
      wallet: 'Портфейл',
      balance: 'Баланс',
      updated: 'Обновено',
      credential: 'Идентификационни данни',
      endpoint: 'Адрес',
      stale: 'Показани са последните валидни данни; последното обновяване се провали.',
      behind: 'закъснение',
      lastError: 'Последна грешка',
      hint: 'Данните идват от влизането в DeepSeek, което Harness вече е запазил; не е нужен API ключ.',
      signIn: 'Влезте отново, за да обновите достъпа до акаунта в DeepSeek.',
      never: 'никога',
      recharge: 'Зареждане',
      promotional: 'Промоционален кредит',
    };

    /** Active translator: the Client locale service replaces this during apply. */
    let t = (key) => en[key] ?? key;
    /** The client root context, captured during apply for lazy service lookup. */
    let rootCtx = null;

    /** Component-local styles, removed with the component that renders them. */
    function Styles() {
      return h('style', {
        dangerouslySetInnerHTML: {
          __html: `
.dsb-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 2px 2px 0; font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-secondary); }
.dsb-item { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.dsb-amount { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsb-amount-ok { color: var(--dsw-alias-state-success-primary); }
.dsb-amount-low { color: var(--dsw-alias-state-warn-primary); }
.dsb-amount-critical { color: var(--dsw-alias-state-error-primary); }
.dsb-error { color: var(--dsw-alias-state-error-primary); }
.dsb-age { color: var(--dsw-alias-state-warn-primary); white-space: nowrap; }
.dsb-page { display: flex; flex-direction: column; gap: 16px; padding: 4px 2px; color: var(--dsw-alias-label-primary); }
.dsb-page-title { font-size: 15px; font-weight: 600; }
.dsb-page-description { font-size: 12px; color: var(--dsw-alias-label-secondary); max-width: 60ch; }
.dsb-hero { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.dsb-hero-amount { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; }
.dsb-hero-caption { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsb-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.dsb-row { display: grid; grid-template-columns: minmax(120px, 1fr) 1fr; gap: 12px; align-items: center; padding: 10px 12px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
.dsb-row:first-child { border-top: 0; }
.dsb-row-head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.dsb-value { font-variant-numeric: tabular-nums; }
.dsb-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsb-meta code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-primary); }
.dsb-actions { display: flex; align-items: center; gap: 10px; }
.dsb-button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
.dsb-button:disabled { opacity: 0.6; cursor: default; }
.dsb-notice { font-size: 12px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.dsb-notice-warn { color: var(--dsw-alias-state-warn-primary); }
.dsb-notice-error { color: var(--dsw-alias-state-error-primary); }
.dsb-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); max-width: 70ch; }
`,
        },
      });
    }

    /**
     * Render a preserved platform amount string in whole cents.
     * @param amount - the raw balance or cost string.
     * @returns a two-decimal string, or an em dash when unusable.
     */
    function cents(amount) {
      if (typeof amount !== 'string' || amount === '') return '–';
      const value = Number(amount);
      if (!Number.isFinite(value)) return amount;
      return value.toFixed(2);
    }

    /**
     * Classify the remaining balance for colour and the low-credit flag.
     * @param amount - the raw balance string.
     * @returns the severity level.
     */
    function levelOf(amount) {
      const value = Number(amount);
      if (!Number.isFinite(value)) return 'ok';
      if (value <= CRITICAL_AMOUNT) return 'critical';
      if (value <= LOW_AMOUNT) return 'low';
      return 'ok';
    }

    /** Severity to the amount's colour class. */
    const LEVEL_CLASS = {
      ok: 'dsb-amount dsb-amount-ok',
      low: 'dsb-amount dsb-amount-low',
      critical: 'dsb-amount dsb-amount-critical',
    };

    /** Severity to the hero amount's colour-only class. */
    const LEVEL_COLOR = {
      ok: 'dsb-amount-ok',
      low: 'dsb-amount-low',
      critical: 'dsb-amount-critical',
    };

    /**
     * Subscribe to the Host's balance route.
     * @returns the current state plus a manual refresh trigger.
     */
    function useBalance() {
      const [state, setState] = React.useState({ status: 'loading', payload: null, pending: false });
      const [, setTick] = React.useState(0);
      const load = React.useCallback(async (force) => {
        setState((current) => ({ ...current, pending: true }));
        try {
          const response = await fetch(force === true ? `${ENDPOINT}?refresh=1` : ENDPOINT, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          const payload = await response.json();
          setState({ status: 'ready', payload, pending: false });
        } catch (error) {
          setState((current) => ({
            status: current.payload === null ? 'error' : 'ready',
            payload: current.payload,
            error: error instanceof Error ? error.message : String(error),
            pending: false,
          }));
        }
      }, []);
      React.useEffect(() => {
        void load(true);
        const timer = setInterval(() => void load(true), POLL_MS);
        return () => clearInterval(timer);
      }, [load]);
      // Re-render on a slow tick so the "behind" age stays honest between polls.
      React.useEffect(() => {
        const timer = setInterval(() => setTick((value) => value + 1), 30000);
        return () => clearInterval(timer);
      }, []);
      return { state, refresh: () => void load(true) };
    }

    /**
     * Read the provider of the model currently selected for this session, so the
     * readout can follow the active model rather than always being visible.
     * @param sessionId - the slot's session id.
     * @returns the provider id, or null when none is selected or unknown.
     */
    function useSelectedProvider(sessionId) {
      const [provider, setProvider] = React.useState(null);
      React.useEffect(() => {
        const dirs = rootCtx === null ? null : (rootCtx.get('modelDirectories') ?? null);
        if (sessionId === null || sessionId === undefined || dirs === null) {
          setProvider(null);
          return;
        }
        let directory;
        try {
          directory = dirs.directoryFor(sessionId);
        } catch {
          setProvider(null);
          return;
        }
        const apply = () => {
          const snapshot = directory.store.getSnapshot();
          const current = snapshot !== null && typeof snapshot === 'object' ? snapshot.current : null;
          setProvider(
            current !== null && typeof current === 'object' && typeof current.provider === 'string'
              ? current.provider
              : null,
          );
        };
        apply();
        const unsubscribe = directory.store.subscribe(apply);
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, [sessionId]);
      return provider;
    }

    /**
     * The ambient readout under the composer. Shows the remaining balance and,
     * when it is known, the total spend so far.
     * @param props - the slot props, including the session id.
     * @returns the readout, a compact failure line, or null when hidden.
     */
    function BalanceStrip(props) {
      const { state } = useBalance();
      const provider = useSelectedProvider(props.sessionId);
      const payload = state.payload;
      const showForAll = payload !== null && payload.showForAllProviders === true;
      const match =
        payload !== null && typeof payload.providerMatch === 'string' && payload.providerMatch !== ''
          ? payload.providerMatch
          : 'deepseek';
      const wanted =
        showForAll ||
        (provider !== null &&
          provider !== undefined &&
          provider.toLowerCase().indexOf(match.toLowerCase()) !== -1);
      if (!wanted) return null;
      if (payload === null || payload.balance === null) {
        if (state.status === 'loading') return h('div', { className: 'dsb-strip' }, t('loading'));
        return h(
          'div',
          { className: 'dsb-strip dsb-error', title: state.error ?? payload?.error ?? '' },
          t('unavailable'),
        );
      }
      const amount = payload.balance.amount;
      const level = levelOf(amount);
      const age = typeof payload.fetchedAt === 'string' ? Date.now() - Date.parse(payload.fetchedAt) : null;
      const lag = age !== null && Number.isFinite(age) && age > LAG_MS ? age : null;
      // The strip shows one thing only: the remaining balance, in whole cents.
      const text = `${t('remaining')}: ${payload.balance.currency} ${cents(amount)}`;
      return h(
        'div',
        { className: 'dsb-strip', 'data-component': 'deepseek-balance-strip' },
        h(Styles, null),
        h(
          'span',
          { className: 'dsb-item', title: text },
          h('span', { className: LEVEL_CLASS[level] ?? LEVEL_CLASS.ok }, text),
        ),
        payload.stale === true ? h('span', { className: 'dsb-error' }, t('stale')) : null,
        lag === null ? null : h('span', { className: 'dsb-age' }, `${t('behind')} ${Math.round(lag / 60000)}m`),
      );
    }

    /**
     * The DeepSeek balance settings page.
     * @returns the full reading with its provenance and a manual refresh.
     */
    function BalanceSettings() {
      const { state, refresh } = useBalance();
      const payload = state.payload;
      const normal = payload !== null && Array.isArray(payload.normalWallets) ? payload.normalWallets : [];
      const bonus = payload !== null && Array.isArray(payload.bonusWallets) ? payload.bonusWallets : [];
      const updated = payload?.fetchedAt == null ? t('never') : new Date(payload.fetchedAt).toLocaleString();
      const primary = payload?.balance ?? null;
      const errorText = state.error ?? payload?.error ?? null;
      const signedOut = typeof errorText === 'string' && errorText.indexOf('sign-in was rejected') !== -1;

      /** One currency table: the recharge wallet and any bonus credit. */
      const table = (heading, rows, field, valueLabel) =>
        rows.length === 0
          ? null
          : h(
              'div',
              { className: 'dsb-card' },
              h(
                'div',
                { className: 'dsb-row dsb-row-head' },
                h('span', null, heading),
                h('span', null, valueLabel),
              ),
              ...rows.map((row, index) =>
                h(
                  'div',
                  { className: 'dsb-row', key: `${field}-${index}` },
                  h('span', null, row.currency),
                  h('span', { className: 'dsb-value' }, cents(row[field])),
                ),
              ),
            );

      return h(
        'div',
        { className: 'dsb-page', 'data-component': 'deepseek-balance-settings' },
        h(Styles, null),
        h('div', { className: 'dsb-page-title' }, t('title')),
        h('div', { className: 'dsb-page-description' }, t('description')),
        errorText === null
          ? null
          : h(
              'div',
              { className: `dsb-notice ${signedOut ? 'dsb-notice-error' : 'dsb-notice-warn'}` },
              `${t('lastError')}: ${errorText}`,
            ),
        payload?.stale === true ? h('div', { className: 'dsb-notice dsb-notice-warn' }, t('stale')) : null,
        primary === null
          ? h('div', { className: 'dsb-hint' }, state.status === 'loading' ? t('loading') : t('unavailable'))
          : h(
              'div',
              { className: 'dsb-hero' },
              h(
                'span',
                { className: `dsb-hero-amount ${LEVEL_COLOR[levelOf(primary.amount)] ?? ''}` },
                `${primary.currency} ${cents(primary.amount)}`,
              ),
              h('span', { className: 'dsb-hero-caption' }, `${t('remaining')} · ${t('recharge')}`),
            ),
        table(t('recharge'), normal, 'balance', t('balance')),
        table(t('promotional'), bonus, 'balance', t('balance')),
        h(
          'div',
          { className: 'dsb-meta' },
          h('span', null, `${t('updated')}: `, h('code', null, updated)),
          h('span', null, `${t('credential')}: `, h('code', null, payload?.credentialSource ?? '–')),
          h('span', null, `${t('endpoint')}: `, h('code', null, payload?.source ?? '–')),
        ),
        h(
          'div',
          { className: 'dsb-actions' },
          h(
            'button',
            { type: 'button', className: 'dsb-button', disabled: state.pending === true, onClick: refresh },
            state.pending === true ? t('loading') : t('refresh'),
          ),
        ),
        h('div', { className: 'dsb-hint' }, t('hint')),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        t = ctx.locale.bind(NS);
        rootCtx = ctx;
        ctx.effect(() => {
          const disposers = [];
          const register = (locale, dict) => {
            try {
              disposers.push(ctx.locale.register(NS, locale, dict));
            } catch (error) {
              console.error(`${NS}: ${locale} dictionary not registered`, error);
            }
          };
          register('en', en);
          register('bg', bg);
          return () => {
            for (const dispose of disposers) dispose();
          };
        }, `${NS}: dictionaries`);
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: NS, order: 5 }, BalanceStrip),
        );
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: NS, order: 31, label: () => t('title') },
            BalanceSettings,
          ),
        );
      },
    };
  },
});
