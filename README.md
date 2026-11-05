# Jira Time Tracker

A macOS menu bar timer that logs your work straight into Jira.

- Click the clock icon in the menu bar to open the tracker. Click it again, press `Esc`, or click anywhere else to hide it. `⌃⌥J` toggles it from anywhere.
- Pick a task from the dropdown: your open assigned issues are listed first, and the search box covers every issue your Jira account can access (by key or text).
- **Start** → work → **Stop & log time**. A worklog is added to the issue with your optional memo as the comment.
- While the timer runs, the menu bar shows the elapsed time and task key.
- The timer lives in the main process: hiding the popover or quitting/restarting the app doesn't lose it.
- If logging fails (offline, expired token), the entry is kept under *Today’s activity* with a **Retry** button. It's also retried automatically the next time you launch or sign in.

Everything runs as you: the app signs in with your own Atlassian email + API token, so you see only your tasks and can only log time where your Jira permissions allow.

## Install

```bash
npm install
npm run install-app   # builds the app, copies it to /Applications, ad-hoc signs it
```

After that, open **Jira Time Tracker** from `/Applications` or Spotlight. It starts at login on its own.

## Connect your Jira account

On first open the app asks for:

1. **Jira site**, e.g. `yourcompany.atlassian.net`
2. **Atlassian account email**
3. **API token**: click **Get API token** in the app. It opens <https://id.atlassian.com/manage-profile/security/api-tokens>; click **Create API token**, copy it, paste it into the app.

The app checks the details against Jira before saving them, encrypted in your macOS Keychain. If the token is later revoked or expires, the app returns to this screen and says why.

## Can't see the menu bar icon?

On MacBooks with a notch, macOS hides menu bar icons that don't fit. Press `⌃⌥J` or reopen the app from Spotlight to show the tracker, then free menu bar space (`⌘`-drag icons off the bar) or use a menu bar manager like [Ice](https://github.com/jordanbaird/ice).

## Develop

```bash
npm start        # menu bar only
npm run dev      # also opens the popover on launch
npm run dist     # .dmg / .zip in dist/ (unsigned)
```

## Notes

- Jira records time in minutes, so sessions are rounded to the nearest minute (minimum 1m). Use **Discard this session** to throw away a mistaken start.
- Right-click the menu bar icon for quick actions: stop/discard, toggle the task key in the menu bar, open Jira, sign out, quit.
- State lives in `~/Library/Application Support/Jira Time Tracker/state.json` (tokens are encrypted).

## Project layout

```
src/main/main.js     tray icon, popover window, IPC
src/main/auth.js     email + API token (Basic auth), Keychain storage
src/main/jira.js     Jira REST calls (issues, search, worklogs)
src/main/tracker.js  timer + worklog queue
src/main/store.js    JSON state + Keychain-encrypted secrets
src/preload.js       safe bridge to the UI
src/renderer/        popover UI (plain HTML/CSS/JS)
scripts/make-icons.mjs  generates the menu bar template icons
```
