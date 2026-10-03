"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Behavioral regression for the extension wiring (Task P2), WITHOUT launching
// VS Code or a network transport. The test injects a fake `vscode` module
// in-memory (pure Module._load interception — no repo filesystem writes),
// loads extension.js once, and exercises the real HermesSidebarProvider
// methods against a recorded fake ACP client:
//   - a persisted ID whose resume fails with an ambiguous-route error must
//     trigger the QuickPick, then one retry carrying _meta.hermesModelId;
//   - a declined QuickPick must leave the original ID intact, send NO
//     session/new, and surface HERMES_SESSION_ROUTE_BLOCKED;
//   - an already-runnable resume must not open the QuickPick;
//   - a route-blocked error in runAgent must end the turn as failed and must
//     never invoke the CLI fallback;
//   - a /stop landing while the route chooser is open must NOT resurrect the
//     turn: no second resume, no model/settings mutation, no prompt, no CLI.
//
// The vscode fixture is minimal but realistic for the APIs the provider calls
// (workspace.getConfiguration, window.showQuickPick/showErrorMessage,
// window.createOutputChannel). No credentials or live Hermes data are read.

const repoRoot = path.join(__dirname, "..");
const Module = require("node:module");

// F2 no-write gate: capture the stub's state before ANY test code runs, so
// the final assertion can prove this run never touched it.
const stubPath = path.join(repoRoot, "node_modules", "vscode", "vscode.js");
const stubFoundBeforeRun = fs.existsSync(stubPath);
const stubMtimeBeforeRun = stubFoundBeforeRun ? fs.statSync(stubPath).mtimeMs : undefined;

const requests = [];
const prompts = [];
const errorMessages = [];
const quickPickItems = [];
let quickPickChoice; // model id to return, or undefined to simulate cancel
// Deferred chooser (Scenario 6): when quickPickParkActive is true, showQuickPick
// PARKS on quickPickPark so the test can interleave a /stop with the choice.
let quickPickPark = null;
let quickPickParkActive = false;
const fakeClient = {
  request: async (method, params) => {
    requests.push({ method, params: JSON.parse(JSON.stringify(params || {})) });
    if (method === "session/resume" && !params._meta?.hermesModelId) {
      throw new Error("route ambiguous");
    }
    if (method === "session/resume") {
      return { models: { currentModelId: params._meta?.hermesModelId }, modes: [], field_meta: {} };
    }
    if (method === "session/new") {
      return { sessionId: "created-by-fallback", models: {} };
    }
    if (method === "session/prompt") {
      prompts.push({ sessionId: params.sessionId });
      const err = new Error("backend route failure after mapping");
      err.code = "HERMES_SESSION_ROUTE_BLOCKED";
      throw err;
    }
    return {};
  },
  prepareStandaloneForNewRun: async () => {},
  ready: Promise.resolve(),
  notify: () => {},
  killAndWait: async () => true,
  suppressCancellationErrorsUntil: 0,
  intentionalStop: false
};

const fakeVscode = {
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => {
        if (key === "command") return "hermes";
        if (key === "useAcp") return true;
        return fallback;
      }
    }),
    workspaceFolders: undefined,
    registerTextDocumentContentProvider: () => ({ dispose: () => {} })
  },
  window: {
    showQuickPick: async (items) => {
      quickPickItems.push(...items.map(item => ({ ...item })));
      if (quickPickParkActive && quickPickPark) await quickPickPark;
      // VS Code showQuickPick returns the selected *item* (or undefined on
      // cancel). Model the fixture on that: pick the item whose modelId
      // matches the scripted choice, or return undefined to simulate cancel.
      if (quickPickChoice === undefined) return undefined;
      return items.find(item => item.modelId === quickPickChoice);
    },
    showErrorMessage: async (text) => { errorMessages.push(text); },
    showWarningMessage: async () => {},
    createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} })
  },
  Uri: { joinPath: (...parts) => ({ fsPath: parts.join("/") }) },
  commands: { executeCommand: async () => {} }
};

const fakeContext = {
  globalState: {
    get: () => undefined,
    update: async () => {},
    keys: () => []
  },
  workspaceState: {
    get: () => undefined,
    update: async () => {},
    keys: () => []
  },
  globalStorageUri: { fsPath: os.tmpdir() },
  extensionPath: repoRoot,
  extension: { packageJSON: { version: "0.2.53" } },
  subscriptions: []
};

// Captured state writes + model-state mutation counter for the /stop test:
// after a cancellation, no session.settings/modelState change or persistence
// may follow the (now invalid) chooser result.
const fakeState = {};
let modelStateChanged = 0;

function makeSession() {
  return {
    id: "ui-session-1",
    acpSessionId: "persisted-old-id",
    messages: [],
    settings: { mode: "Auto" },
    get modelState() {
      modelStateChanged += 1;
      return this._modelStateValue;
    },
    set modelState(value) {
      this._modelStateValue = value;
    },
    _modelStateValue: {
      options: [
        { id: "custom:cpa:gpt-6.1-sol", name: "CPA / gpt-6.1-sol" },
        { id: "custom:baqis-fast:qwen-test", name: "BAQIS / qwen-test" }
      ],
      current: ""
    }
  };
}

function makeProvider() {
  // Isolate file/network reads: point the extension at a temp HERMES_HOME so
  // no live Hermes config/sessions are touched.
  process.env.HERMES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-acp-cancel-test-"));
  fakeContext.globalState.update = async (key, value) => { fakeState[key] = value; };
  fakeContext.workspaceState.update = async (key, value) => { fakeState[key] = value; };

  const provider = new HermesSidebarProvider(fakeContext);
  provider.acp = fakeClient;
  provider.acpSessions = new Map();
  provider.retiredAcpSessions = new Set();
  provider.sessions = [makeSession()];
  provider.activeSessionId = provider.sessions[0].id;
  return provider;
}

// Make `require("vscode")` (and any nested require of it, e.g. from
// extension.js) return the fake — entirely in memory. The interception wraps
// Module._load for exactly one request name; every other module loads
// untouched. No stub file is written to the repository: resolution of the
// bare "vscode" specifier is never reached, so the (obsolete) persistent
// node_modules/vscode/vscode.js placeholder can be left for a separate
// cleanup. The hook and the extension's require-cache entries are restored
// in the process-exit "finally" (exitFlush) below.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line global-require
const { HermesSidebarProvider } = require(path.join(repoRoot, "extension.js"));

(async () => {
  // Scenario 1: confirmed QuickPick — resume retry with the chosen id, no new.
  {
    requests.length = 0;
    quickPickItems.length = 0;
    errorMessages.length = 0;
    quickPickChoice = "custom:cpa:gpt-6.1-sol";
    const provider = makeProvider();
    const session = provider.sessions[0];
    const result = await provider.ensureMappedAcpSession(fakeClient, session);
    assert.equal(result, "persisted-old-id", "original ACP id must be returned on confirmed recovery");
    assert.equal(session.acpSessionId, "persisted-old-id", "original id must stay on the session");
    assert.equal(provider.acpSessions.get(session.id), "persisted-old-id");
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map(request => request.method),
      ["session/resume", "session/resume"],
      "exactly one confirmed retry; never session/new"
    );
    assert.equal(requests[0].params.sessionId, "persisted-old-id");
    assert.equal(requests[0].params._meta, undefined, "first attempt must not carry a route hint");
    assert.equal(requests[1].params.sessionId, "persisted-old-id");
    assert.equal(requests[1].params._meta?.hermesModelId, "custom:cpa:gpt-6.1-sol");
    assert.equal(session.settings?.model, "custom:cpa:gpt-6.1-sol", "confirmed choice must become session.settings.model");
    assert.ok(
      quickPickItems.length >= 2 && quickPickItems.every(item => /^custom:[^:]+:.+$/.test(item.modelId)),
      "QuickPick must list named provider/model routes"
    );
    assert.ok(quickPickItems.some(item => item.description === "custom:cpa:gpt-6.1-sol"));
  }

  // Scenario 2: declined QuickPick — id preserved, no session/new, blocked error.
  {
    requests.length = 0;
    quickPickItems.length = 0;
    errorMessages.length = 0;
    quickPickChoice = undefined;
    const provider = makeProvider();
    const session = provider.sessions[0];
    await assert.rejects(
      provider.ensureMappedAcpSession(fakeClient, session),
      (error) => error.code === "HERMES_SESSION_ROUTE_BLOCKED"
    );
    assert.equal(session.acpSessionId, "persisted-old-id", "decline must NOT clear the persisted id");
    assert.equal(provider.acpSessions.get(session.id), "persisted-old-id");
    assert.equal(
      requests.filter(request => request.method === "session/new").length,
      0,
      "decline must never create a replacement session"
    );
    assert.deepEqual(
      requests.map(request => request.method),
      ["session/resume"],
      "no retry after a declined choice"
    );
    assert.ok(quickPickItems.length >= 2, "QuickPick must have been offered once");
  }

  // Scenario 3: resume succeeds first try — QuickPick never opens.
  {
    requests.length = 0;
    quickPickItems.length = 0;
    quickPickChoice = "custom:cpa:gpt-6.1-sol";
    let calls = 0;
    const healthyClient = {
      request: async (method, params) => {
        calls += 1;
        requests.push({ method, params });
        return { models: { currentModelId: "custom:cpa:gpt-6.1-sol" } };
      },
      prepareStandaloneForNewRun: async () => {},
      ready: Promise.resolve()
    };
    const provider = makeProvider();
    const session = provider.sessions[0];
    const result = await provider.ensureMappedAcpSession(healthyClient, session);
    assert.equal(result, "persisted-old-id");
    assert.equal(calls, 1);
    assert.equal(quickPickItems.length, 0, "no choice prompt when the resume already works");
    assert.equal(session.acpSessionId, "persisted-old-id");
  }

  // Scenario 4: runAgent — a route-blocked ACP turn fails in place; the CLI
  // fallback (which spawns the configured command) is never invoked.
  {
    requests.length = 0;
    prompts.length = 0;
    quickPickChoice = undefined;
    const provider = makeProvider();
    const session = provider.sessions[0];
    const userMessage = { id: "u1", text: "hi" };
    const assistantMessage = {
      id: "a1",
      status: "running",
      text: "",
      thinking: [],
      startedAt: Date.now()
    };
    await provider.runAgent("hi", userMessage, assistantMessage, session.id);
    assert.equal(assistantMessage.status, "failed", "blocked route must fail the turn");
    assert.ok(
      assistantMessage.thinking.some(block => block.kind === "error" && /route/i.test(block.title)),
      "blocked route must surface a route-specific error block"
    );
    assert.equal(prompts.length, 0, "no session/prompt after a blocked route");
    assert.equal(provider.cliClient, undefined, "CLI fallback must not start a background host");
    assert.equal(provider.cliTurns.size, 0, "CLI fallback must not register a CLI turn");
  }

  // Scenario 5: resume fails and no named route exists in the model inventory —
  // an error message explains the dead end; nothing is created, id preserved.
  {
    requests.length = 0;
    quickPickItems.length = 0;
    errorMessages.length = 0;
    quickPickChoice = undefined;
    const provider = makeProvider();
    const session = provider.sessions[0];
    session._modelStateValue = {
      options: [{ id: "openrouter:deepseek-v4-flash", name: "openrouter / deepseek-v4-flash" }],
      current: ""
    };
    await assert.rejects(
      provider.ensureMappedAcpSession(fakeClient, session),
      (error) => error.code === "HERMES_SESSION_ROUTE_BLOCKED"
    );
    assert.equal(errorMessages.length, 1, "a missing named route must be explained once");
    assert.ok(/named Hermes route/i.test(errorMessages[0]));
    assert.equal(quickPickItems.length, 0, "no QuickPick when nothing named is selectable");
    assert.equal(session.acpSessionId, "persisted-old-id");
    assert.equal(requests.filter(request => request.method === "session/new").length, 0);
  }

  // Scenario 6: /stop lands while the route chooser is open — the deferred
  // pick must NOT resurrect the turn: no second resume with _meta, no
  // model/settings mutation, no session/prompt, no CLI, and the turn stays
  // stopped. The first resume's failure was already dispatched to the backend
  // and cannot be rolled back — that boundary is asserted, not hidden.
  // QuickPick undefined-cancel (Scenario 2) is a DIFFERENT case: a deliberate
  // decline, not a /stop.
  {
    requests.length = 0;
    prompts.length = 0;
    quickPickItems.length = 0;
    errorMessages.length = 0;
    quickPickChoice = "custom:baqis-fast:qwen-test"; // valid selection — arrives AFTER /stop
    quickPickParkActive = true;
    global.__parkResolve = null;
    quickPickPark = new Promise(resolve => { global.__parkResolve = resolve; });
    Object.keys(fakeState).forEach(key => { delete fakeState[key]; });
    const provider = makeProvider();
    const session = provider.sessions[0];
    const userMessage = { id: "u6", text: "go", createdAt: Date.now() };
    const assistantMessage = {
      id: "a6", role: "assistant", text: "", status: "running",
      thinking: [], startedAt: Date.now()
    };
    const run = provider.runAcp("hermes", "go", userMessage, assistantMessage, session.id);
    run.catch(() => {}); // rejection eagerly consumed; settlement verified below
    // Wait until the chooser is genuinely open: first resume already failed
    // with the ambiguous-route error and showQuickPick is parked.
    await Promise.race([
      new Promise(resolve => {
        const tick = () => (quickPickItems.length >= 2 && global.__parkResolve) ? resolve() : setTimeout(tick, 5);
        tick();
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("scenario 6: QuickPick did not open within 5s")), 5000))
    ]);
    // /stop on the ACTIVE turn lifecycle (turn registered, pre-mapping:
    // acpSessionId undefined — exactly the real window: user pressed stop
    // while the QuickPick was on screen).
    const stopResult = await provider.stop(session.id);
    assert.equal(stopResult, true, "/stop must report a successful stop");
    assert.equal(assistantMessage.status, "stopped", "/stop must mark the message stopped");
    // Now the pick lands — after the /stop. The recovery must observe the
    // cancellation and NOT proceed with the retry.
    global.__parkResolve();
    quickPickPark = null;
    quickPickParkActive = false;
    await run.catch(error => {
      // The turn is cancelled, so runAcp settles with the cancellation
      // marker — re-using HERMES_TURN_CANCELLED (TurnCancelledError /
      // isTurnCancelled), never a re-wrapped route block or a re-sent prompt.
      assert.equal(error.code, "HERMES_TURN_CANCELLED", "a /stop-cancelled turn must settle as turn-cancelled, not re-block or re-prompt");
    });
    const resumed = requests.filter(request => request.method === "session/resume");
    assert.equal(resumed.length, 1, "/stop during the chooser must NOT trigger a second resume — the user said stop");
    assert.equal(resumed[0].params._meta, undefined, "first attempt (already dispatched) carries no hint and cannot be rolled back");
    assert.equal(prompts.length, 0, "no session/prompt: the stopped turn must not run");
    assert.equal(provider.cliClient, undefined, "CLI fallback must not start after /stop");
    assert.equal(provider.cliTurns.size, 0, "CLI fallback must not register a turn after /stop");
    assert.equal(session.acpSessionId, "persisted-old-id", "the original id survives on the session object");
    // Note: provider.acpSessions.get(session.id) is undefined after /stop
    // because the force-stop path clears the in-memory ACP mapping (by design:
    // the transport is torn down). The session object's acpSessionId is the
    // source of truth for persistence.
    // No hermes config/state may have been persisted by the CANCELLED recovery
    // path itself (the /stop saveSessions is expected and allowed).
    for (const key of Object.keys(fakeState)) {
      assert.ok(
        key === "hermesAgent.workspaceAgentState" || key === "hermesAgent.sessions",
        `unexpected state write during /stop recovery: ${key}`
      );
    }
    // Explicit boundary: an already-dispatched first request is kept, only
    // the post-chooser work is gated on the turn state.
    assert.ok(resumed.length === 1 && resumed[0].params._meta === undefined, "boundary: dispatched first request kept, its retry is suppressed by /stop");
  }

  // Scenario 7: normal command path — with NO active turn lifecycle, the
  // chooser still recovers (confirming the cancellation gating is scoped to
  // an active run, not a global block).
  {
    requests.length = 0;
    quickPickItems.length = 0;
    quickPickChoice = "custom:cpa:gpt-6.1-sol";
    quickPickPark = null;
    quickPickParkActive = false;
    const provider = makeProvider();
    const session = provider.sessions[0];
    const result = await provider.ensureMappedAcpSession(fakeClient, session);
    assert.equal(result, "persisted-old-id");
    assert.deepEqual(
      requests.map(request => request.method),
      ["session/resume", "session/resume"],
      "no active lifecycle: the confirmed retry still happens"
    );
    assert.equal(session.settings?.model, "custom:cpa:gpt-6.1-sol");
  }

  // Wiring (F1): this test must be part of the dedicated recovery gate and of
  // the standard chains, so the package.json and this file stay in sync.
  {
    const pkg = require(path.join(repoRoot, "package.json"));
    assert.equal(typeof pkg.scripts["lint:recovery"], "string", "lint:recovery script must exist");
    assert.equal(typeof pkg.scripts["test:recovery"], "string", "test:recovery script must exist");
    assert.ok(pkg.scripts["lint:recovery"].includes("node --check test/session-route-recovery-extension.test.js"), "lint:recovery must node --check this wiring test");
    assert.ok(pkg.scripts["test:recovery"].includes("node test/session-route-recovery-extension.test.js"), "test:recovery must run this wiring test");
    assert.ok(pkg.scripts.lint.includes("node --check test/session-route-recovery-extension.test.js"), "lint must node --check this wiring test");
    assert.ok(pkg.scripts["test:unit"].includes("node test/session-route-recovery-extension.test.js"), "test:unit must run this wiring test");
  }

  // No-repo-writes (F2): the mock is pure in memory. This run must neither
  // write the stub file nor modify its mtime — the persistent placeholder
  // (obsolete, cleaned up separately by the parent) stays exactly as found.
  {
    assert.equal(
      fs.existsSync(stubPath),
      stubFoundBeforeRun,
      "this run must not create or delete node_modules/vscode/vscode.js"
    );
    if (stubFoundBeforeRun) {
      assert.equal(
        fs.statSync(stubPath).mtimeMs,
        stubMtimeBeforeRun,
        "this run must not touch node_modules/vscode/vscode.js"
      );
    }
  }

  // Restore the module system: unload the fake "vscode" interception and the
  // extension's cached modules, so nothing leaks past process exit.
  function exitFlush() {
    try {
      if (Module._load !== originalLoad) Module._load = originalLoad;
    } catch { /* best effort */ }
    try {
      for (const key of Object.keys(require.cache)) {
        if (key.endsWith(path.join("extension.js"))) delete require.cache[key];
      }
    } catch { /* best effort */ }
  }
  process.once("beforeExit", exitFlush);

  console.log("extension route recovery wiring: 7 scenarios passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
