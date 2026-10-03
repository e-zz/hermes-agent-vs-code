"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Behavioral regression for the extension wiring (Task P2), WITHOUT launching
// VS Code or a network transport. The test injects a fake `vscode` module into
// require.cache, loads extension.js once, and exercises the real
// HermesSidebarProvider methods against a recorded fake ACP client:
//   - a persisted ID whose resume fails with an ambiguous-route error must
//     trigger the QuickPick, then one retry carrying _meta.hermesModelId;
//   - a declined QuickPick must leave the original ID intact, send NO
//     session/new, and surface HERMES_SESSION_ROUTE_BLOCKED;
//   - an already-runnable resume must not open the QuickPick;
//   - a route-blocked error in runAgent must end the turn as failed and must
//     never invoke the CLI fallback.
//
// The vscode fixture is minimal but realistic for the APIs the provider calls
// (workspace.getConfiguration, window.showQuickPick/showErrorMessage,
// window.createOutputChannel). No credentials or live Hermes data are read.

const repoRoot = path.join(__dirname, "..");
const Module = require("node:module");
const vscodePath = path.join(repoRoot, "node_modules", "vscode", "vscode.js");
fs.mkdirSync(path.dirname(vscodePath), { recursive: true });
fs.writeFileSync(vscodePath, "module.exports = {};\n");

const requests = [];
const prompts = [];
const errorMessages = [];
const quickPickItems = [];
let quickPickChoice; // model id to return, or undefined to simulate cancel
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
  ready: Promise.resolve()
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

// Make `require("vscode")` (and any nested require of it, e.g. from
// extension.js) return the fake. A bare specifier is not satisfied by
// require.cache alone on this Node version, so the resolver is shimmed for
// exactly one request name; every other module loads from disk untouched.
// The `vscode.js` file written above keeps resolution from touching the
// VS Code extension host.
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return vscodePath;
  return originalResolveFilename.call(this, request, ...rest);
};
require.cache[vscodePath] = {
  id: vscodePath,
  filename: vscodePath,
  loaded: true,
  exports: fakeVscode
};

// eslint-disable-next-line global-require
const { HermesSidebarProvider } = require(path.join(repoRoot, "extension.js"));

function makeSession() {
  return {
    id: "ui-session-1",
    acpSessionId: "persisted-old-id",
    messages: [],
    settings: { mode: "Auto" },
    modelState: {
      options: [
        { id: "custom:cpa:gpt-6.1-sol", name: "CPA / gpt-6.1-sol" },
        { id: "custom:baqis-fast:qwen-test", name: "BAQIS / qwen-test" }
      ],
      current: ""
    }
  };
}

function makeProvider() {
  const provider = new HermesSidebarProvider(fakeContext);
  provider.acp = fakeClient;
  provider.acpSessions = new Map();
  provider.retiredAcpSessions = new Set();
  provider.sessions = [makeSession()];
  provider.activeSessionId = provider.sessions[0].id;
  return provider;
}

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
    session.modelState = {
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

  console.log("extension route recovery wiring: 5 scenarios passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
