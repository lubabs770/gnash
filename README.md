# gnash

A local web UI for seeing and safely editing Firefox's `user.js`. For every pref it
shows the install's default, the `prefs.js` value and the `user.js` value side by side.

`about:config` edits `prefs.js` only, has no descriptions, and never tells you a
`user.js` line is overriding something. gnash does.

## Run

Needs Node 24+.

```sh
npm install
npm start
```

Your browser opens on a one-time link. Pick a profile, filter, edit, review the
diff, apply.

## What it does

**Customize**: sliders, toggles and choosers for about 30 curated prefs (density,
interface scale, vertical tabs, fonts, colors, scrolling, tab behavior, sponsored
stuff), next to a simulated Firefox window that updates as you drag. Curated controls
live in [`data/controls.json`](data/controls.json).

**Live**: flip the Live switch and gnash starts Firefox on the profile with
remote control on (Marionette), then applies each change in real Firefox as you
make it. Save keeps changes in `user.js`; anything unsaved is undone when you turn
Live off or quit gnash. Firefox must not already be running on that profile, and it
shows a robot icon and striped address bar until you restart it normally. While Live
is on, other programs on your computer could also control that Firefox.

**All prefs**: the full three-way table, with toggles for booleans and typed editors
for everything else.

Under the hood:

- Finds profiles from `profiles.ini` / `installs.ini` and lets you pick one.
  Profile locations live in [`data/paths.json`](data/paths.json).
- Reads defaults from the profile's own install (`omni.ja`), so values match your
  exact Firefox version.
- Edits `user.js` only. Your comments, order and formatting are kept; new prefs go
  under a `// --- added by gnash ---` section. A symlinked `user.js` stays linked.
- Every write: you review a diff → `user.js` and `prefs.js` are copied to
  `.gnash-backups/<time>/` in the profile (last 20 kept) → atomic write. If
  `user.js` changed since you reviewed, the write is refused.

## Security

The server writes into your browser profile, so it trusts nothing:

- Listens on `127.0.0.1` only, on a random port.
- A random token in the launch link becomes an HttpOnly, SameSite=Strict cookie;
  every request needs it.
- Rejects any `Host` other than `127.0.0.1:<port>` / `localhost:<port>` (DNS rebinding).
- Writes need a matching `Origin` and a JSON body; no CORS headers.
- The UI never sees file paths, only profile IDs the server issued.
- Strict Content-Security-Policy; file contents are rendered as text, never HTML.
- Shuts down after 10 minutes with no open tab, undoing unsaved live changes.
- Live mode is off until you turn it on, and talks to Firefox only over loopback.

## Limits

- Removing a pref from `user.js` doesn't reset it in `prefs.js`; Firefox keeps
  the last value. A cleaner for that is planned.
- Prefs compiled into Firefox (`StaticPrefList.yaml`) show "no default" until the
  description bundle arrives in v0.3.
- Tested on macOS. Linux and Windows paths are in place but unverified.

## Develop

```sh
npm test          # node:test, no build step (Node runs the TypeScript directly)
npm run typecheck
npm run dev       # restart on change, don't open a browser
```

Layout: `packages/prefs` (parser/editor), `apps/server` (HTTP, discovery, omni.ja,
writes), `apps/web` (one HTML file, no framework), `data/` (profile paths).

## Roadmap

- **Next**: Windows, Linux, Flatpak, Snap and forks verified; single executables
  from CI; cleaner and backup restore in the UI; more curated controls.
- **v0.3**: pref descriptions and categories, built in CI from mozilla-central
  and other sources; flag prefs that no longer exist.

## License

MIT
