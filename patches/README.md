# Fixes against Hermes Agent for VS Code 0.2.53

Each patch applies cleanly, on its own, to the upstream release commit
`a8b2f8f` ("release: sync Hermes Agent 0.2.53 source", which is `origin/main`).

    git apply patches/00-all-fixes-combined.patch              # everything
    git apply patches/01-acp-lifecycle-home-and-exec.patch     # or one fix at a time

The shards partition the change exactly: concatenated in the order below, their
combined diff equals `00-all-fixes-combined.patch` byte for byte. No file
appears in more than one shard and none is omitted — `background/host.js` is
covered by 01 only. Eight source files change; nothing under `patches/` is part
of any patch.

## What each patch fixes

**01-acp-lifecycle-home-and-exec** — `background/host.js`, `extension.js`,
`lib/acp-client.js`, `lib/acp-render.js`, `lib/background-client.js`,
`lib/reasoning-config.js`

The largest group: the ACP session lifecycle, hermes-home resolution, log
capture, and how the backend is spawned. They change together because they meet
in the same code paths.

- `resolveHermesHome()` replaces a hard-coded `~/.hermes`. The extension looked
  for the backend in a fixed location, which is wrong on Windows (Hermes lives
  under `%LOCALAPPDATA%`) and on any install that sets its own home.
- `hermesConfig()` reads the configured provider list, so a provider defined in
  `config.yaml` is offered by the model picker.
- Spawns the backend with `shell: false` and `windowsHide: true`. Routing the
  command through a shell meant `cmd.exe` re-parsed the arguments, so any path
  containing a space or a metacharacter could be mangled, and a console window
  flashed on every launch. An optional `env` is threaded through to the child so
  callers can pass `HERMES_HOME` and socket variables explicitly.
- The host's idle lifetime is lengthened (30 s is too short: the background host
  exited between prompts, so each message paid a cold-start cost and in-flight
  work could be cut off), and the client's idle expectation is kept in step with
  it so the client does not decide the host has gone away while it is alive.
- Raw ACP stderr is persisted to `acp-stderr.log`. The extension filters stderr
  down to `ERROR`/`CRITICAL`/`Traceback` lines, so a handshake failure carrying
  none of those markers vanished without trace. The detached host's own output
  goes to `host.log`, necessary because its stdio is `'ignore'` on Windows.
- `lib/acp-render.js` — the steer deadlock. Steering replaces the turn's
  assistant message with a continuation and marks the original `continued`. The
  completion guard then read the *new* message, which no longer matched, so the
  turn was never finalized and the continuation stayed `running` forever.
  Because `running` is what drives `sessionIsRunning`, the composer locked up
  permanently. `finalizeCurrent()` closes whichever message the renderer
  currently points at and forces a terminal state rather than deferring;
  `completeTurn()` legitimately returns `needsFinalAnswer: true` and leaves a
  message `running` when it has no answer text yet, expecting a second call that
  a steer continuation never makes. The ordinary turn path is unchanged.

**02-node-runtime-candidate-selection** — `lib/node-runtime.js`

Stops disqualifying a candidate whose path equals the current `execPath`. When
VS Code's own extension host runs on system Node, that Node *is* the correct
background host; the old check rejected it and could leave no valid candidate at
all. Application-runtime detection also now matches `Code.exe`.

**03-chat-scroll-jump** — `media/main.js`

Drops the `window.scrollTo(0, 0)` that fired on every panel re-layout, which
made the chat jump to the top whenever an editor tab closed.

## Verifying

Every patch was verified against `a8b2f8f` by applying it in a scratch worktree
and comparing to this branch's HEAD (`30d0d67`):

    git worktree add --detach /tmp/v a8b2f8f
    cd /tmp/v && git apply <repo>/patches/00-all-fixes-combined.patch
    git hash-object background/host.js extension.js lib/*.js media/*.js

All eight blobs must equal `git rev-parse HEAD:<file>` on this branch. Compare
**git-normalized** hashes, not raw bytes — with `core.autocrlf=true` the checkout
is CRLF while the stored blobs are LF, so a byte-for-byte comparison of the
working tree reports false failures.

To confirm the shards really partition, concatenate 01+02+03 in that order and
diff against `00-all-fixes-combined.patch`: no output means exact.

Note that `npm test` and `npm run lint` cannot run on upstream as published:
`package.json` still references 26 files under `test/`, but the directory was
deleted in `8a5d247` ("Delete test directory"). Syntax-check the sources
directly instead:

    for f in extension.js background/*.js lib/*.js media/*.js; do node --check "$f"; done
