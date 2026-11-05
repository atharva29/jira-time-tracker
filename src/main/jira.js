// Jira Cloud REST client. Every call runs as the signed-in user, so results
// only include issues that user can see.
const auth = require('./auth');
const store = require('./store');

const ISSUE_FIELDS = ['summary', 'status', 'project', 'issuetype'];

async function apiFetch(url, { method = 'GET', body } = {}, creds) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth.authHeader(creds),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
  });

  if (res.status === 401) {
    if (creds) throw new auth.AuthError('Jira rejected that email + API token. Check both and try again.');
    // Stored token stopped working (expired / revoked): drop it and explain why.
    const notice = 'Jira rejected your saved API token — it has probably expired or been revoked. Create a new one to continue.';
    auth.clearCredentials(notice);
    throw new auth.AuthError(notice);
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const msgs = [...(data?.errorMessages || []), ...Object.values(data?.errors || {})];
    const err = new Error(msgs.join(' ') || data?.message || `Jira request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function jiraUrl(path, query, site = store.get('site')) {
  if (!site) throw new auth.AuthError();
  const url = new URL(`${site.url}/rest/api/3${path}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  return url;
}

function mapUser(me) {
  return {
    accountId: me.accountId,
    displayName: me.displayName,
    email: me.emailAddress || null,
    timeZone: me.timeZone || null,
  };
}

async function myself() {
  return mapUser(await apiFetch(jiraUrl('/myself')));
}

// Check a site + email + token before saving them.
async function verify(site, creds) {
  let me;
  try {
    me = await apiFetch(jiraUrl('/myself', null, site), {}, creds);
  } catch (e) {
    if (e.code === 'AUTH_REQUIRED') throw e;
    if (e.status === 404) throw new Error(`No Jira found at ${site.url}`);
    if (e.cause?.code === 'ENOTFOUND' || /fetch failed/i.test(e.message)) {
      throw new Error(`Couldn’t reach ${site.url}. Check the site address and your connection.`);
    }
    throw e;
  }
  if (!me?.accountId) throw new Error(`No Jira found at ${site.url}`);
  return mapUser(me);
}

function mapIssue(i) {
  const f = i.fields || {};
  return {
    key: i.key,
    summary: f.summary || '',
    status: f.status?.name || null,
    statusCategory: f.status?.statusCategory?.key || null, // new | indeterminate | done
    project: f.project?.name || null,
    type: f.issuetype?.name || null,
  };
}

async function searchJql(jql, maxResults = 50) {
  const data = await apiFetch(jiraUrl('/search/jql'), {
    method: 'POST',
    body: { jql, maxResults, fields: ISSUE_FIELDS },
  });
  return (data?.issues || []).map(mapIssue);
}

function assignedIssues() {
  return searchJql('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC', 100);
}

// Full-text / key search across everything the user can access.
async function searchIssues(query) {
  const q = query.trim();
  if (!q) return [];
  const picker = await apiFetch(
    jiraUrl('/issue/picker', { query: q, showSubTasks: 'true', showSubTaskParent: 'true' })
  );
  const seen = new Set();
  const hits = [];
  for (const section of picker?.sections || []) {
    for (const issue of section.issues || []) {
      if (seen.has(issue.key)) continue;
      seen.add(issue.key);
      hits.push({ key: issue.key, summary: issue.summaryText || '' });
    }
  }
  if (!hits.length) return [];
  // Hydrate with status/project for a consistent list; fall back to picker data.
  try {
    const keys = hits.slice(0, 50).map((h) => h.key);
    const full = await searchJql(`key in (${keys.join(',')})`, keys.length);
    const byKey = new Map(full.map((i) => [i.key, i]));
    return keys.map((k) => byKey.get(k) || hits.find((h) => h.key === k));
  } catch {
    return hits.slice(0, 50);
  }
}

function jiraDateTime(ms) {
  const d = new Date(ms);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${off >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

async function addWorklog(issueKey, { startedAt, seconds, comment }) {
  const body = { started: jiraDateTime(startedAt), timeSpentSeconds: seconds };
  if (comment?.trim()) {
    body.comment = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: comment.trim() }] }],
    };
  }
  const data = await apiFetch(jiraUrl(`/issue/${encodeURIComponent(issueKey)}/worklog`), {
    method: 'POST',
    body,
  });
  return { worklogId: data?.id };
}

module.exports = { verify, myself, assignedIssues, searchIssues, addWorklog, jiraDateTime };
