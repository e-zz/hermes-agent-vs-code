# Local fixes for eyanlin.hermes-agent-vscode

This is **not** upstream. It is the installed extension directory, turned into a
git repo so the local modifications are visible and revertible.

Upstream: https://github.com/eyan-ai/hermes-agent-vs-code
Base version: `0.2.53`

## Layout

```
d616d85  v0.2.53 vendor baseline (as shipped by marketplace)
f79e1aa  Local fixes  <- HEAD
```

`git diff d616d85..f79e1aa` is the complete set of changes.
`git checkout d616d85 -- .` restores the extension to as-shipped.

## What was fixed

| # | File | Change |
|---|---|---|
| 1 | `extension.js` | Inject `HERMES_HOME` into the ACP host env; background session lifecycle |
| 2 | `lib/acp-client.js` | `shell:true` -> `shell:false` + `windowsHide:true` (console-window popup) |
| 3 | `lib/reasoning-config.js` | same no-shell + `windowsHide` treatment |
| 4 | `background/host.js` | same no-shell + `windowsHide`; idle exit 30s -> 10min |
| 5 | `lib/background-client.js` | runtime install / stdout handling |

Full analysis with evidence and per-claim verification points:
`docs/hermes-agent-vscode-defects-2026-09-28.md`

## patches/

Generated from `d616d85..f79e1aa`, so they reproduce `f79e1aa` exactly.

| File | Applies to |
|---|---|
| `00-all-fixes-combined.patch` | everything at once |
| `01-extension-hermes-home-and-lifecycle.patch` | `extension.js` |
| `02-acp-client-no-shell.patch` | `lib/acp-client.js` |
| `03-reasoning-config-no-shell.patch` | `lib/reasoning-config.js` |
| `04-host-no-shell-and-idle.patch` | `background/host.js` |
| `05-background-client.patch` | `lib/background-client.js` |

### Re-applying after a marketplace upgrade

The marketplace replaces this whole directory on a version bump. To carry the
fixes onto a new version:

```bash
git apply --check patches/00-all-fixes-combined.patch   # dry run first
git apply patches/00-all-fixes-combined.patch
```

`--check` first, always. If upstream has moved the same lines, the check fails
and you resolve by hand rather than getting a half-applied tree.

### Verifying a patch matches the current code

```bash
git apply --check --reverse patches/00-all-fixes-combined.patch
```

A clean reverse-apply proves the patch corresponds exactly to what is in the
tree. Use this instead of trusting the patch is current.

## Scope note

The patches cover the extension only. Two separate defects live in the Hermes
**backend** (`acp_adapter/content.py`, `acp_adapter/server.py`); those are fixed
in the `hermes-agent` repo, not here. See the defects doc, section B.

## Caveat carried from the analysis

Dropping `shell:true` also changes the `where.exe node` fallback in
`lib/node-runtime.js:132` — `cmd.exe` resolved `node` more permissively than
Node's own spawn does. This does not create the `node-runtime` defect
(see the defects doc, A2), but it can make that defect surface where it
previously did not. **Test the no-shell change and the node-runtime defect
independently**; do not treat them as one change.
