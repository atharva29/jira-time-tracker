// Jira Cloud sign-in with the user's own email + API token (HTTP Basic auth).
// No OAuth app needed: each user creates a personal token at Atlassian and
// pastes it into the app. Credentials are encrypted with the macOS Keychain.
const store = require('./store');

const TOKEN_PAGE_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

class AuthError extends Error {
  constructor(message = 'Please connect your Jira account') {
    super(message);
    this.code = 'AUTH_REQUIRED';
  }
}

// Accepts "acme", "acme.atlassian.net", "https://acme.atlassian.net/jira/your-work", …
function normalizeSite(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter your Jira site, e.g. yourcompany.atlassian.net');
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error('That doesn’t look like a Jira site address');
  }
  let host = url.hostname.toLowerCase();
  if (!host.includes('.')) host = `${host}.atlassian.net`;
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error('That doesn’t look like a Jira site address');
  return { url: `https://${host}`, name: host.replace(/\.atlassian\.net$/, '') };
}

function getCredentials() {
  return store.getSecret('jiraCredentials');
}

function saveCredentials({ email, token }) {
  store.setSecret('jiraCredentials', { email, token });
}

function clearCredentials(notice) {
  store.setSecret('jiraCredentials', null);
  if (notice) store.set('authNotice', notice);
}

function isAuthenticated() {
  return !!getCredentials()?.token && !!store.get('site');
}

function authHeader(creds = getCredentials()) {
  if (!creds?.token) throw new AuthError();
  return `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`;
}

module.exports = {
  AuthError,
  TOKEN_PAGE_URL,
  normalizeSite,
  getCredentials,
  saveCredentials,
  clearCredentials,
  isAuthenticated,
  authHeader,
};
