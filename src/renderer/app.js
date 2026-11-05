'use strict';

const $ = (id) => document.getElementById(id);
const bridge = window.api;

let S = null; // app state pushed from the main process
const ui = {
  selected: loadSelected(),
  assigned: [],
  assignedAt: 0,
  loadingAssigned: false,
  query: '',
  results: null,
  searching: false,
  searchSeq: 0,
  options: [],
  active: 0,
  memoDraft: '',
};

// ---------- helpers ----------

async function call(name, ...args) {
  const r = await bridge[name](...args);
  if (r.ok) return r.data;
  const err = new Error(r.error);
  err.code = r.code;
  throw err;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDur(seconds) {
  const m = Math.round(seconds / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 5000 : 2800);
}

function loadSelected() {
  try {
    return JSON.parse(localStorage.getItem('selectedIssue')) || null;
  } catch {
    return null;
  }
}

function saveSelected(issue) {
  try {
    localStorage.setItem('selectedIssue', JSON.stringify(issue));
  } catch {
    /* ignore */
  }
}

// ---------- views ----------

function currentView() {
  return S.authenticated && S.site ? 'main' : 'signin';
}

function render() {
  if (!S) return;
  const view = currentView();
  for (const v of ['signin', 'main']) $(`view-${v}`).hidden = v !== view;
  ({ signin: renderSignin, main: renderMain })[view]();
}

let prefilled = false;
function renderSignin() {
  // Prefill once with what was used last time (e.g. after a token expired).
  if (!prefilled) {
    prefilled = true;
    if (!$('site').value) $('site').value = S.lastSite || '';
    if (!$('email').value) $('email').value = S.lastEmail || '';
  }
  $('auth-notice').hidden = !S.authNotice;
  $('auth-notice').textContent = S.authNotice || '';
}

function focusFirstEmptyField() {
  const first = ['site', 'email', 'token'].map($).find((i) => !i.value.trim()) || $('connect-btn');
  first.focus();
}

function renderMain() {
  const { user, site, timer } = S;
  $('avatar').textContent = initials(user?.displayName);
  $('user-name').textContent = user?.displayName || 'Signed in';
  $('site-name').textContent = site?.name || '';

  const running = !!timer;
  $('timer-card').classList.toggle('running', running);
  $('status-text').textContent = running ? 'Tracking' : 'Not tracking';

  const issue = running ? timer.issue : ui.selected;
  const label = $('combo-label');
  label.replaceChildren(
    ...(issue
      ? [el('span', { class: 'key', text: issue.key }), el('span', { class: 'summary', text: issue.summary })]
      : [el('span', { class: 'placeholder', text: 'Select a task…' })])
  );
  $('combo').disabled = running;
  $('combo').title = running ? 'Stop the timer to switch tasks' : '';
  if (running) closeDropdown();

  const memo = $('memo');
  if (document.activeElement !== memo) memo.value = running ? timer.memo || '' : ui.memoDraft;

  const btn = $('toggle-btn');
  btn.classList.toggle('running', running);
  btn.disabled = !running && !ui.selected;
  $('toggle-label').textContent = running ? 'Stop & log time' : 'Start';
  $('discard-btn').hidden = !running;

  renderEntries();
  tick();
}

function renderEntries() {
  const list = $('entries');
  const items = S.today.map((e) => {
    const stateIcon = { logged: '✓', pending: '', failed: '!' }[e.status];
    const sub = e.status === 'failed'
      ? el('div', { class: 'entry-sub err', text: `Not logged: ${e.error}` })
      : el('div', { class: 'entry-sub', text: [`${fmtTime(e.startedAt)} – ${fmtTime(e.endedAt)}`, e.memo].filter(Boolean).join(' · ') });
    return el(
      'li',
      {},
      el('span', { class: `entry-state ${e.status}`, title: e.status }, e.status === 'pending' ? el('span', { class: 'spinner' }) : stateIcon),
      el(
        'div',
        { class: 'entry-main' },
        el(
          'div',
          { class: 'row1' },
          el('button', { class: 'key as-link', text: e.issue.key, title: 'Open in Jira', onclick: () => call('openIssue', e.issue.key) }),
          el('span', { class: 'summary', text: e.issue.summary })
        ),
        sub
      ),
      e.status === 'failed'
        ? [
            el('button', { class: 'link small', text: 'Retry', onclick: () => retry(e.id) }),
            el('button', { class: 'icon-btn small', title: 'Remove', text: '×', onclick: () => call('removeEntry', e.id) }),
          ]
        : el('span', { class: 'entry-dur', text: fmtDur(e.seconds) })
    );
  });
  list.replaceChildren(...items);
  $('entries-empty').hidden = items.length > 0;
}

function tick() {
  if (!S || currentView() !== 'main') return;
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const now = Date.now();
  let total = S.today.reduce((sum, e) => sum + e.seconds, 0);
  if (S.timer) {
    $('elapsed').textContent = fmtClock(now - S.timer.startedAt);
    total += (now - Math.max(S.timer.startedAt, startOfDay)) / 1000;
  } else {
    $('elapsed').textContent = '0:00:00';
  }
  $('today-total').textContent = fmtDur(total);
}
setInterval(tick, 1000);

// ---------- task dropdown ----------

function openDropdown() {
  if ($('combo').disabled) return;
  $('dropdown').hidden = false;
  $('combo').setAttribute('aria-expanded', 'true');
  $('search').value = ui.query;
  $('search').focus();
  $('search').select();
  if (Date.now() - ui.assignedAt > 60_000) loadAssigned();
  renderOptions();
}

function closeDropdown() {
  $('dropdown').hidden = true;
  $('combo').setAttribute('aria-expanded', 'false');
}

async function loadAssigned(force = false) {
  if (ui.loadingAssigned && !force) return;
  ui.loadingAssigned = true;
  renderOptions();
  try {
    ui.assigned = await call('assignedIssues');
    ui.assignedAt = Date.now();
  } catch (e) {
    toast(e.message, true);
  } finally {
    ui.loadingAssigned = false;
    renderOptions();
  }
}

function matches(issue, q) {
  const needle = q.toLowerCase();
  return issue.key.toLowerCase().includes(needle) || (issue.summary || '').toLowerCase().includes(needle);
}

function buildGroups() {
  const q = ui.query.trim();
  const groups = [];
  const seen = new Set();
  const take = (list) => list.filter((i) => !seen.has(i.key) && seen.add(i.key));

  if (!q) {
    const recent = take(S.recent.slice(0, 4).map((r) => ui.assigned.find((a) => a.key === r.key) || r));
    if (recent.length) groups.push({ title: 'Recent', items: recent });
    const mine = take(ui.assigned);
    groups.push({ title: 'Assigned to me', items: mine, loading: ui.loadingAssigned && !ui.assigned.length });
  } else {
    const local = take([...ui.assigned, ...S.recent].filter((i) => matches(i, q)));
    if (local.length) groups.push({ title: 'Assigned to me', items: local });
    const remote = take(ui.results || []);
    groups.push({ title: 'All issues you can access', items: remote, loading: ui.searching });
  }
  return groups;
}

function renderOptions() {
  if ($('dropdown').hidden) return;
  const groups = buildGroups();
  ui.options = groups.flatMap((g) => g.items);
  ui.active = Math.min(ui.active, Math.max(0, ui.options.length - 1));

  const nodes = [];
  let idx = 0;
  for (const g of groups) {
    nodes.push(el('div', { class: 'group', text: g.title }));
    if (g.loading) nodes.push(el('div', { class: 'list-msg' }, el('span', { class: 'spinner' }), 'Loading…'));
    else if (!g.items.length) nodes.push(el('div', { class: 'list-msg', text: ui.query ? 'No matches' : 'No open tasks assigned to you' }));
    for (const issue of g.items) {
      const i = idx++;
      nodes.push(
        el(
          'div',
          {
            class: `option${i === ui.active ? ' active' : ''}`,
            role: 'option',
            'data-idx': i,
            onmousemove: () => setActive(i),
            onmousedown: (ev) => {
              ev.preventDefault();
              selectIssue(issue);
            },
          },
          el('div', { class: 'row1' }, el('span', { class: 'key', text: issue.key }), el('span', { class: 'summary', text: issue.summary })),
          issue.status || issue.project
            ? el(
                'div',
                { class: 'row2' },
                issue.status ? el('span', { class: `pill ${issue.statusCategory || ''}`, text: issue.status }) : null,
                issue.project ? el('span', { class: 'summary', text: issue.project }) : null
              )
            : null
        )
      );
    }
  }
  $('issue-list').replaceChildren(...nodes);
}

function setActive(i) {
  if (i === ui.active) return;
  ui.active = i;
  for (const n of $('issue-list').querySelectorAll('.option')) n.classList.toggle('active', Number(n.dataset.idx) === i);
}

function moveActive(delta) {
  if (!ui.options.length) return;
  setActive((ui.active + delta + ui.options.length) % ui.options.length);
  $('issue-list').querySelector('.option.active')?.scrollIntoView({ block: 'nearest' });
}

function selectIssue(issue) {
  ui.selected = { key: issue.key, summary: issue.summary || '' };
  saveSelected(ui.selected);
  closeDropdown();
  render();
  $('toggle-btn').focus();
}

let searchDebounce;
function onSearchInput() {
  ui.query = $('search').value;
  ui.active = 0;
  clearTimeout(searchDebounce);
  const q = ui.query.trim();
  ui.results = null;
  ui.searching = !!q;
  renderOptions();
  if (!q) return;
  searchDebounce = setTimeout(async () => {
    const seq = ++ui.searchSeq;
    try {
      const res = await call('searchIssues', q);
      if (seq !== ui.searchSeq) return;
      ui.results = res;
    } catch (e) {
      if (seq !== ui.searchSeq) return;
      ui.results = [];
      toast(e.message, true);
    }
    ui.searching = false;
    renderOptions();
  }, 280);
}

// ---------- actions ----------

let connecting = false;
async function connect(e) {
  e?.preventDefault();
  if (connecting) return;
  const errBox = $('connect-error');
  errBox.hidden = true;
  connecting = true;
  $('connect-btn').disabled = true;
  $('connect-btn').replaceChildren(el('span', { class: 'spinner light' }), 'Checking with Jira…');
  try {
    const user = await call('connect', {
      site: $('site').value,
      email: $('email').value,
      token: $('token').value,
    });
    $('token').value = '';
    ui.assigned = [];
    ui.assignedAt = 0;
    toast(`Connected as ${user.displayName}`);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
  } finally {
    connecting = false;
    $('connect-btn').disabled = false;
    $('connect-btn').textContent = 'Connect';
  }
}

let toggling = false;
async function toggleTimer() {
  if (toggling) return;
  toggling = true;
  $('toggle-btn').disabled = true;
  try {
    if (S.timer) {
      const entry = await call('stop', { memo: $('memo').value });
      ui.memoDraft = '';
      $('memo').value = '';
      if (entry?.status === 'logged') toast(`Logged ${fmtDur(entry.seconds)} to ${entry.issue.key}`);
      else if (entry?.status === 'failed') toast(`Couldn’t log to Jira: ${entry.error}. Saved — retry below.`, true);
    } else {
      if (!ui.selected) return;
      await call('start', ui.selected, $('memo').value);
    }
  } catch (e) {
    toast(e.message, true);
  } finally {
    toggling = false;
    render();
  }
}

// Two-click confirm (a native dialog would blur and hide the popover).
let discardArmed = null;
async function discard() {
  const btn = $('discard-btn');
  if (!discardArmed) {
    btn.textContent = 'Click again to discard — nothing will be logged';
    discardArmed = setTimeout(() => {
      discardArmed = null;
      btn.textContent = 'Discard this session';
    }, 3000);
    return;
  }
  clearTimeout(discardArmed);
  discardArmed = null;
  btn.textContent = 'Discard this session';
  try {
    await call('stop', { discard: true });
    toast('Session discarded');
  } catch (e) {
    toast(e.message, true);
  }
}

async function retry(id) {
  try {
    const entry = await call('retry', id);
    if (entry.status === 'logged') toast(`Logged ${fmtDur(entry.seconds)} to ${entry.issue.key}`);
    else toast(entry.error, true);
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- wiring ----------

$('connect-form').addEventListener('submit', connect);
$('token-page-btn').addEventListener('click', () => call('openTokenPage'));
$('token-toggle').addEventListener('click', () => {
  const t = $('token');
  const show = t.type === 'password';
  t.type = show ? 'text' : 'password';
  $('token-toggle').title = show ? 'Hide token' : 'Show token';
});
for (const id of ['site', 'email', 'token']) {
  $(id).addEventListener('input', () => ($('connect-error').hidden = true));
}

$('menu-btn').addEventListener('click', () => call('showMenu'));
$('combo').addEventListener('click', () => ($('dropdown').hidden ? openDropdown() : closeDropdown()));
$('search').addEventListener('input', onSearchInput);
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const issue = ui.options[ui.active];
    if (issue) selectIssue(issue);
  }
});
$('refresh-btn').addEventListener('click', () => {
  loadAssigned(true);
  if (ui.query.trim()) onSearchInput();
  $('search').focus();
});
document.addEventListener('mousedown', (e) => {
  if (!$('dropdown').hidden && !e.target.closest('.combo-wrap')) closeDropdown();
});

let memoDebounce;
$('memo').addEventListener('input', () => {
  const value = $('memo').value;
  if (S?.timer) {
    clearTimeout(memoDebounce);
    memoDebounce = setTimeout(() => call('updateMemo', value).catch(() => {}), 400);
  } else {
    ui.memoDraft = value;
  }
});
$('memo').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('toggle-btn').disabled) toggleTimer();
});
$('toggle-btn').addEventListener('click', toggleTimer);
$('discard-btn').addEventListener('click', discard);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('dropdown').hidden) closeDropdown();
  else call('hide');
});

bridge.onState((state) => {
  const wasAuthed = S?.authenticated && S?.site;
  S = state;
  if (!(state.authenticated && state.site)) {
    ui.assigned = [];
    ui.assignedAt = 0;
  } else if (!wasAuthed) {
    loadAssigned();
  }
  render();
});

bridge.onToast(({ message, isError }) => toast(message, isError));

bridge.onShown(() => {
  render();
  if (S && currentView() === 'signin') focusFirstEmptyField();
  if (S && currentView() === 'main' && Date.now() - ui.assignedAt > 120_000) loadAssigned();
});

(async () => {
  S = await call('getState');
  render();
  if (currentView() === 'main') loadAssigned();
})();
