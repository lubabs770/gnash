# gnash

A local web UI for seeing and safely editing Firefox `user.js`, with a three-way
view of the default, `prefs.js` and `user.js` value for every pref.

Status: early. Only `packages/prefs` exists so far: a `user_pref(...)` parser and
editor that round-trips files byte-for-byte, so edits never reformat the user's file.

```sh
bun test
```

## Plan

- **v0.1** (macOS, Firefox): profile discovery, parsers, defaults from `omni.ja`,
  three-way table, edit `user.js`, lock check → diff → backup → atomic write,
  loopback-only server with session token.
- **v0.2**: Windows, Linux, Flatpak, Snap, forks; single-binary builds from CI.
- **v0.3**: pref descriptions bundle built in CI.
