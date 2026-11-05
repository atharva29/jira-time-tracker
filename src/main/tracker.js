// Timer + worklog history. Lives in the main process so it keeps running
// while the popover is hidden and survives app restarts.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const store = require('./store');
const jira = require('./jira');

const MAX_HISTORY = 200;
const events = new EventEmitter();
const changed = () => events.emit('change');

function getTimer() {
  return store.get('timer', null);
}

function start(issue, memo = '') {
  if (!issue?.key) throw new Error('Pick a task first');
  if (getTimer()) throw new Error('Timer is already running');
  store.set('timer', {
    issue: { key: issue.key, summary: issue.summary || '' },
    startedAt: Date.now(),
    memo,
  });
  rememberRecent(issue);
  changed();
}

function updateMemo(memo) {
  const timer = getTimer();
  if (!timer) return;
  store.set('timer', { ...timer, memo: String(memo || '').slice(0, 2000) });
}

// Jira tracks time in minutes: round to the nearest minute, at least 1m.
function billableSeconds(ms) {
  return Math.max(60, Math.round(ms / 60000) * 60);
}

async function stop({ discard = false, memo } = {}) {
  const timer = getTimer();
  if (!timer) throw new Error('Timer is not running');
  store.set('timer', null);
  changed();
  if (discard) return null;

  const endedAt = Date.now();
  const entry = {
    id: crypto.randomUUID(),
    issue: timer.issue,
    startedAt: timer.startedAt,
    endedAt,
    seconds: billableSeconds(endedAt - timer.startedAt),
    memo: memo ?? timer.memo ?? '',
    status: 'pending',
    error: null,
  };
  saveEntry(entry);
  return push(entry.id);
}

async function push(id) {
  let entry = findEntry(id);
  if (!entry) throw new Error('Entry not found');
  if (entry.status === 'logged') return entry;
  saveEntry({ ...entry, status: 'pending', error: null });
  changed();
  try {
    const { worklogId } = await jira.addWorklog(entry.issue.key, {
      startedAt: entry.startedAt,
      seconds: entry.seconds,
      comment: entry.memo,
    });
    entry = { ...entry, status: 'logged', worklogId, error: null };
  } catch (e) {
    entry = { ...entry, status: 'failed', error: e.message };
  }
  saveEntry(entry);
  changed();
  return entry;
}

// Retry everything that failed (e.g. after coming back online or re-login).
async function retryFailed() {
  const failed = history().filter((e) => e.status !== 'logged');
  for (const e of failed) await push(e.id);
}

function history() {
  return store.get('history', []);
}

function findEntry(id) {
  return history().find((e) => e.id === id);
}

function saveEntry(entry) {
  const list = history().filter((e) => e.id !== entry.id);
  list.unshift(entry);
  store.set('history', list.slice(0, MAX_HISTORY));
}

function removeEntry(id) {
  store.set('history', history().filter((e) => e.id !== id));
  changed();
}

function rememberRecent(issue) {
  const recent = store.get('recentIssues', []).filter((i) => i.key !== issue.key);
  recent.unshift({ key: issue.key, summary: issue.summary || '' });
  store.set('recentIssues', recent.slice(0, 8));
}

function clearAll() {
  store.set('timer', undefined);
  store.set('history', undefined);
  store.set('recentIssues', undefined);
  changed();
}

module.exports = {
  events,
  getTimer,
  start,
  stop,
  updateMemo,
  push,
  retryFailed,
  history,
  removeEntry,
  clearAll,
};
