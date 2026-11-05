// Tiny JSON persistence in the app's userData folder.
// Secrets (OAuth client secret, tokens) are encrypted with the macOS Keychain via safeStorage.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

let state = null;
const file = () => path.join(app.getPath('userData'), 'state.json');

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    state = {};
  }
  return state;
}

function save() {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function get(key, fallback) {
  const value = load()[key];
  return value === undefined ? fallback : value;
}

function set(key, value) {
  load();
  if (value === undefined) delete state[key];
  else state[key] = value;
  save();
}

function setSecret(key, value) {
  if (value == null) return set(key, undefined);
  const json = JSON.stringify(value);
  if (safeStorage.isEncryptionAvailable()) {
    set(key, { enc: true, data: safeStorage.encryptString(json).toString('base64') });
  } else {
    set(key, { enc: false, data: json });
  }
}

function getSecret(key) {
  const stored = get(key);
  if (!stored) return null;
  try {
    const json = stored.enc
      ? safeStorage.decryptString(Buffer.from(stored.data, 'base64'))
      : stored.data;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

module.exports = { get, set, getSecret, setSecret };
