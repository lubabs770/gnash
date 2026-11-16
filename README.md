# gnash

A local studio for Firefox's `user.js`, `userChrome.css` and `userContent.css`: edit them
as much as you like and watch a real Firefox change as you type.

`about:config` edits `prefs.js` only, has no descriptions, and never tells you a
`user.js` line is overriding something. gnash does.

## Run

Needs Node 24+.

```sh
npm install
npm start
```

Your browser opens on a one-time link. Pick a profile, open the Studio, and turn on
Live.

## What it does

**Studio**: an editor for `user.js`, `userChrome.css` and `userContent.css`, with
syntax highlighting, pref-name autocomplete, and a note on each `user.js` line (its
default, "= default", "not a known pref", overridden lines, type errors). ⌘S saves,
with a backup.

**Live**: opens a copy of your profile (prefs, toolbar layout, extensions, `chrome/`
assets) in a second Firefox window with remote control on. Every edit shows up there
as you type, whether you type in gnash or save from your own editor: gnash watches the
files. Your everyday Firefox keeps running and isn't touched; nothing reaches your
real profile until you save. Closing the live copy quits it and deletes the copy.
The copy shows a robot icon and striped address bar (Firefox's remote-control mode),
and while it's open, other programs on your computer could also control it.

**Customize**: sliders, toggles and choosers for about 30 curated prefs (density,
interface scale, vertical tabs, fonts, colors, scrolling, tab behavior, sponsored
stuff), next to a simulated Firefox window that updates as you drag. Curated controls
live in [`data/controls.json`](data/controls.json).

**All prefs**: the full three-way table, with toggles for booleans and typed editors
for everything else.

Under the hood:

- Finds profiles from `profiles.ini` / `installs.ini` and lets you pick one.
  Profile locations live in [`data/paths.json`](data/paths.json).
- Reads defaults from the profile's own install (`omni.ja`), so values match your
  exact Firefox version.
- Customize and All prefs edit `user.js` without touching your comments, order or
  formatting; new prefs go under a `// --- added by gnash ---` section. Symlinked files
  (say, from a dotfiles repo) stay linked, and gnash watches their real location.
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
- Live mode is off until you turn it on, runs on a throwaway copy, and talks to that
  Firefox only over loopback.

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
