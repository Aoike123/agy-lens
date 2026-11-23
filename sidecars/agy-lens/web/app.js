// Agy Lens panel entry point: state, polling, tab/language switching, and controller wiring.

import {
  createTranslator,
  detectDefaultLang,
  localeFor,
  normalizeLang,
} from './i18n.js';
import {
  CYCLE_PERIODS,
  esc,
  getJson as fetchJson,
  HISTORY_VIEWS,
  PERIODS,
  QUOTA_STALE_MS,
  HISTORY_STALE_MS,
  TABS,
} from './format.js';
import { createOverviewController } from './views/overview.js';
import { createQuotaController } from './views/quota.js';
import { createHistoryController } from './views/history.js';

const POLL_MS = 3000;
const AUTO_REFRESH_MS = 65 * 1000;

let t = null;
let tab = 'overview';
let booted = false;

function escapeBootHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function formatBootError(err) {
  if (!err) return 'Unknown startup error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.name || 'Error';
  if (typeof err.message === 'string' && err.message) return err.message;
  if (typeof err.reason !== 'undefined') return formatBootError(err.reason);
  try { return String(err); } catch { return 'Unknown startup error'; }
}

function showBootError(err) {
  if (typeof document === 'undefined') return;
  const target = document.getElementById('overview') || document.body;
  if (!target) return;
  if (booted && (tab !== 'overview' || !target.querySelector('[data-i18n="loading"]'))) return;
  const title = typeof t === 'function' ? t('requestFailed') : 'Failed to start Agy Lens';
  target.innerHTML = `<div class="error" role="alert" data-boot-error><b>${escapeBootHtml(title)}</b>${escapeBootHtml(formatBootError(err))}</div>`;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('error', (ev) => {
    showBootError((ev && (ev.error || ev.message)) || ev);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    showBootError(ev && ev.reason);
  });
  if (typeof window.onerror !== 'function') {
    window.onerror = (msg, _src, _line, _col, err) => {
      showBootError(err || msg);
      return false;
    };
  }

  try {
    const params = new URLSearchParams(location.search);
    const conversationId = (window.sidecar && window.sidecar.conversationId) || params.get('conversationId') || '';
    const doFetch = (window.sidecar && window.sidecar.fetch) || fetch;
    const getJson = (path, query) => fetchJson(path, query, doFetch);

    const $ = (id) => document.getElementById(id);
    const panes = { overview: $('overview'), quota: $('quota'), history: $('history') };

    const store = {
      get(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } },
      set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
      remove(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
    };

    let lang = detectDefaultLang(typeof navigator !== 'undefined' ? navigator.language : '', store.get('ctx.lang', ''));
    t = createTranslator(lang);
    tab = TABS.includes(store.get('ctx.tab', 'overview')) ? store.get('ctx.tab', 'overview') : 'overview';
    let workspace = '';
    const openKeys = new Set();
    let updateInfo = null;

    function updateInstallCommand() {
      const plat = typeof navigator !== 'undefined'
        ? `${navigator.platform || ''} ${navigator.userAgent || ''}`
        : '';
      return /win/i.test(plat)
        ? 'irm https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.ps1 | iex'
        : 'curl -fsSL https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.sh | bash';
    }

    function renderUpdateBanner() {
      const el = $('update-banner');
      if (!el) return;
      const latest = updateInfo && updateInfo.latest_version ? String(updateInfo.latest_version) : '';
      const current = updateInfo && updateInfo.current_version ? String(updateInfo.current_version) : '';
      const dismissed = store.get('ctx.dismissedUpdate', '');
      if (!updateInfo || !updateInfo.update_available || !latest || dismissed === latest) {
        el.hidden = true;
        el.innerHTML = '';
        return;
      }
      const rawUrl = String(updateInfo.release_url || '');
      const safeUrl = /^https:\/\/github\.com\/Aoike123\/agy-lens(?:\/|$)/.test(rawUrl) ? rawUrl : '';
      const linkHtml = safeUrl
        ? `<a class="update-link" href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer">${esc(t('viewRelease'))}</a>`
        : '';
      el.innerHTML = `<span class="update-msg num"><span class="update-dot" aria-hidden="true"></span><span class="ellipsis">${esc(t('updateAvailable', latest, current))}</span></span>`
        + `<span class="update-acts"><button type="button" class="update-cmd-btn" data-copy-update>${esc(t('copyUpdateCmd'))}</button>${linkHtml}`
        + `<button type="button" class="update-dismiss" data-dismiss-update aria-label="${esc(t('dismissUpdate'))}" title="${esc(t('dismissUpdate'))}">&times;</button></span>`;
      el.hidden = false;
    }

    async function copyUpdateCommand(btn) {
      const cmd = updateInstallCommand();
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(cmd);
        } else {
          throw new Error('no clipboard');
        }
      } catch {
        const ta = document.createElement('textarea');
        ta.value = cmd;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      if (btn) {
        btn.textContent = t('copied');
        setTimeout(() => {
          const curBtn = $('update-banner')?.querySelector('[data-copy-update]');
          if (curBtn) curBtn.textContent = t('copyUpdateCmd');
        }, 1500);
      }
    }

    async function checkUpdate() {
      try {
        const res = await getJson('/api/update');
        if (res && typeof res === 'object' && !res.error && res.update_available && res.latest_version) {
          updateInfo = res;
          renderUpdateBanner();
        }
      } catch { /* update check is best-effort and never blocks panel startup */ }
    }

    function keepScroll(fn) {
      const y = window.scrollY;
      fn();
      if (window.scrollY !== y) window.scrollTo(0, y);
    }

    function setMeta(id, html, tip) {
      const el = $(`${id}-meta`);
      if (!el) return;
      el.innerHTML = html;
      el.hidden = !html;
      if (tip !== undefined) el.title = tip;
    }

    let overview;
    let quota;
    let history;

    function syncRefreshButton() {
      const btn = $('refresh');
      if (!btn) return;
      const busy = Boolean(
        (tab === 'overview' && overview && overview.isSpinning())
        || (tab === 'quota' && quota && quota.loader.loading)
        || (tab === 'history' && history && history.loader.loading),
      );
      btn.classList.toggle('busy', busy);
      btn.setAttribute('aria-busy', String(busy));
      const tip = t('refreshTip', tab === 'overview' ? 3 : 60);
      btn.title = tip;
      btn.setAttribute('aria-label', tip);
    }

    overview = createOverviewController({
      pane: panes.overview,
      conversationId,
      getWorkspace: () => workspace,
      getTab: () => tab,
      getHistoryLoader: () => history && history.loader,
      getQuotaLoader: () => quota && quota.loader,
      openKeys,
      getT: () => t,
      getLang: () => lang,
      getJson,
      keepScroll,
      onSpinChange: syncRefreshButton,
    });

    quota = createQuotaController({
      pane: panes.quota,
      store,
      openKeys,
      getTab: () => tab,
      getHistoryData: () => (history ? history.loader.data : null),
      getT: () => t,
      getLang: () => lang,
      getJson,
      keepScroll,
      setMeta,
      onBusyChange: syncRefreshButton,
      onDataChange: () => {
        if (history) history.syncFromQuota();
        if (overview) overview.syncWeekly();
      },
    });

    history = createHistoryController({
      pane: panes.history,
      store,
      openKeys,
      getTab: () => tab,
      getQuotaData: () => (quota ? quota.loader.data : null),
      getT: () => t,
      getLang: () => lang,
      getJson,
      keepScroll,
      setMeta,
      onBusyChange: syncRefreshButton,
      onPricingSynced: () => {
        if (overview && overview.getReport()) overview.refresh({ force: true });
      },
      onDataChange: () => {
        if (quota && (quota.loader.data || quota.loader.error)) quota.paint();
        if (overview) overview.syncWeekly();
      },
    });

    function ensureQuotaForHistory(force = false) {
      if (quota.loader.loading) return;
      if (force || !quota.loader.data || Date.now() - quota.loader.loadedAt > QUOTA_STALE_MS) {
        quota.loader.load({ refresh: force, silent: true });
      }
    }

    function ensureHistoryForQuota(force = false) {
      if (history.loader.loading) return;
      if (force || !history.loader.data || Date.now() - history.loader.loadedAt > HISTORY_STALE_MS) {
        history.loader.load({ refresh: force, silent: true });
      }
    }

    function applyStatic() {
      document.documentElement.lang = localeFor(lang);
      document.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = t(el.getAttribute('data-i18n'));
      });
      const pill = $('lang');
      if (pill) {
        pill.setAttribute('aria-label', t('langAria'));
        pill.querySelectorAll('[data-lang]').forEach((b) => {
          b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
        });
      }
      syncRefreshButton();
    }

    function setTab(next) {
      tab = TABS.includes(next) ? next : 'overview';
      store.set('ctx.tab', tab);
      document.querySelectorAll('.tab').forEach((b) => {
        const on = b.dataset.tab === tab;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      TABS.forEach((k) => { panes[k].hidden = k !== tab; });
      syncRefreshButton();
      if (tab === 'overview') {
        overview.syncWeekly();
        overview.ensureWeekly();
        overview.refresh();
      } else if (tab === 'quota') {
        quota.loader.open();
        ensureHistoryForQuota(false);
      } else {
        history.loader.open();
        ensureQuotaForHistory(false);
      }
    }

    function setLang(next) {
      lang = normalizeLang(next);
      t = createTranslator(lang);
      store.set('ctx.lang', lang);
      applyStatic();
      renderUpdateBanner();
      overview.paint();
      if (quota.loader.data || quota.loader.loading || quota.loader.error) quota.paint();
      if (history.loader.data || history.loader.loading || history.loader.error) history.paint();
      history.refreshShareCard();
    }

    function autoRefreshActive() {
      if (document.hidden) return;
      if (tab === 'quota' && quota.loader.data) {
        quota.loader.load({ refresh: false, silent: true });
        ensureHistoryForQuota(false);
      } else if (tab === 'history' && history.loader.data) {
        history.loader.load({ refresh: false, silent: true });
        ensureQuotaForHistory(false);
      }
    }

    function onWake() {
      if (document.hidden) return;
      if (tab === 'overview') { overview.refresh(); return; }
      if (tab === 'quota') {
        quota.tickCountdowns();
        if (quota.loader.data && Date.now() - quota.loader.loadedAt > QUOTA_STALE_MS) quota.loader.load({ refresh: false, silent: true });
        ensureHistoryForQuota(false);
      } else if (tab === 'history') {
        if (history.loader.data && Date.now() - history.loader.loadedAt > HISTORY_STALE_MS) history.loader.load({ refresh: false, silent: true });
        ensureQuotaForHistory(false);
      }
    }

    document.querySelector('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('.tab');
      if (b) setTab(b.dataset.tab);
    });

    document.querySelector('.tabs').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const i = TABS.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
      setTab(TABS[(i + TABS.length) % TABS.length]);
      const btn = document.querySelector(`.tab[data-tab="${tab}"]`);
      if (btn) btn.focus();
    });

    $('refresh').addEventListener('click', () => {
      if (tab === 'overview') overview.refresh({ force: true });
      else if (tab === 'quota') {
        quota.loader.load({ refresh: true, silent: false });
        ensureHistoryForQuota(true);
      } else {
        history.clearPricingNotice();
        history.loader.load({ refresh: true, silent: false });
        ensureQuotaForHistory(true);
      }
    });

    $('lang').addEventListener('click', (e) => {
      const b = e.target.closest('[data-lang]');
      if (b && b.dataset.lang !== lang) setLang(b.dataset.lang);
    });

    document.addEventListener('click', (e) => {
      const copyUpd = e.target.closest('[data-copy-update]');
      if (copyUpd) { copyUpdateCommand(copyUpd); return; }

      if (e.target.closest('[data-dismiss-update]')) {
        if (updateInfo && updateInfo.latest_version) {
          store.set('ctx.dismissedUpdate', String(updateInfo.latest_version));
        }
        renderUpdateBanner();
        return;
      }

      const goTab = e.target.closest('[data-go-tab]');
      if (goTab) { setTab(goTab.dataset.goTab); return; }

      const retryBtn = e.target.closest('[data-retry]');
      if (retryBtn) {
        if (retryBtn.dataset.retry === 'quota') quota.loader.load({ refresh: true, silent: false });
        else if (retryBtn.dataset.retry === 'history') {
          history.clearPricingNotice();
          history.loader.load({ refresh: true, silent: false });
          ensureQuotaForHistory(true);
        }
        return;
      }

      const hv = e.target.closest('[data-hview]');
      if (hv) { history.setHistoryView(hv.dataset.hview, false); return; }

      const sp = e.target.closest('[data-speriod]');
      if (sp) { history.setSessionsPeriod(sp.dataset.speriod); return; }

      const hs = e.target.closest('[data-hsort]');
      if (hs) { history.setListSort(hs.dataset.hsort); return; }

      const hsrc = e.target.closest('[data-hsource]');
      if (hsrc) { history.setListSource(hsrc.dataset.hsource); return; }

      if (e.target.closest('[data-hide-sub]')) { history.toggleHideSubagents(); return; }
      if (e.target.closest('#history-search-clear')) { history.setSearchQuery('', { clearInput: true }); return; }
      if (e.target.closest('[data-share-card]')) { history.openShareCard(); return; }
      if (e.target.closest('[data-sync-prices]')) { history.syncPricing(); return; }

      const modBtn = e.target.closest('[data-toggle-models]');
      if (modBtn) { history.toggleModels(modBtn); return; }

      if (e.target.closest('[data-more-sessions]')) { history.moreSessions(); return; }
      if (e.target.closest('[data-more-list]')) { history.moreList(); return; }

      const qp = e.target.closest('[data-qperiod]');
      if (qp) { quota.setCyclePeriod(qp.dataset.qperiod, false); return; }

      const pBtn = e.target.closest('[data-period]');
      if (pBtn) history.setPeriod(pBtn.dataset.period, false);
    });

    panes.quota.addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('.period-bar') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const i = CYCLE_PERIODS.indexOf(quota.getCyclePeriod()) + (e.key === 'ArrowRight' ? 1 : -1);
        quota.setCyclePeriod(CYCLE_PERIODS[(i + CYCLE_PERIODS.length) % CYCLE_PERIODS.length], true);
      }
    });

    panes.history.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'history-search') {
        history.setSearchQuery(e.target.value);
      }
    });

    panes.history.addEventListener('keydown', (e) => {
      if (e.target && e.target.id === 'history-search' && e.key === 'Escape' && history.getSearchQuery()) {
        e.preventDefault();
        e.target.value = '';
        history.setSearchQuery('');
        return;
      }
      if (e.target.closest && e.target.closest('.seg') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const i = HISTORY_VIEWS.indexOf(history.getHistoryView()) + (e.key === 'ArrowRight' ? 1 : -1);
        history.setHistoryView(HISTORY_VIEWS[(i + HISTORY_VIEWS.length) % HISTORY_VIEWS.length], true);
        return;
      }
      if (e.target.closest && e.target.closest('.period-bar') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const i = PERIODS.indexOf(history.getPeriod()) + (e.key === 'ArrowRight' ? 1 : -1);
        history.setPeriod(PERIODS[(i + PERIODS.length) % PERIODS.length], true);
      }
    });

    document.addEventListener('toggle', (e) => {
      const d = e.target;
      if (!d || !d.matches || !d.matches('details[data-key]')) return;
      if (d.open) openKeys.add(d.dataset.key); else openKeys.delete(d.dataset.key);
      if (d.open) history.expandChildren(d);
    }, true);

    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);

    async function start() {
      applyStatic();
      if (window.sidecar && window.sidecar.getWorkspaceUris) {
        try {
          const uris = await window.sidecar.getWorkspaceUris();
          workspace = (uris && uris[0]) || '';
        } catch { /* no workspace */ }
        if (window.sidecar.onWorkspaceChange) {
          window.sidecar.onWorkspaceChange((next) => {
            const w = (next && next[0]) || '';
            if (w !== workspace) {
              workspace = w;
              overview.resetCache();
              overview.refresh();
            }
          });
        }
      }
      setTab(tab);
      booted = true;
      checkUpdate();
      setInterval(() => overview.refresh(), POLL_MS);
      setInterval(() => quota.tickCountdowns(), 1000);
      setInterval(autoRefreshActive, AUTO_REFRESH_MS);
    }

    start().catch(showBootError);
  } catch (err) {
    showBootError(err);
  }
}
