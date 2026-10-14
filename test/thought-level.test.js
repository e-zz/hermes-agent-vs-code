"use strict";
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};

const fakeVscode = {
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    workspaceFolders: undefined,
  }
};

const { HermesSidebarProvider } = require(path.join(repoRoot, "extension.js"));

function configOptions(currentValue) {
  return [{
    id: "thought_level",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue,
    options: [
      { value: "default", name: "Default" },
      { value: "high", name: "High (sends max on this route)" },
      { value: "ultra", name: "Ultra (sends max on this route)" }
    ]
  }];
}

function makeProvider() {
  const session = {
    id: "ui-1",
    messages: [],
    settings: { mode: "Auto", model: "route-1" },
    modelState: { current: "route-1", options: [{ id: "route-1", name: "Route 1" }] }
  };
  const requests = [];
  const posted = [];
  const provider = Object.create(HermesSidebarProvider.prototype);
  provider.sessions = [session];
  provider.activeSessionId = session.id;
  provider.acpSessions = new Map([[session.id, "acp-1"]]);
  provider.acp = {
    request: async (method, params) => {
      requests.push({ method, params });
      assert.equal(method, "session/set_config_option");
      return { configOptions: configOptions("ultra") };
    }
  };
  provider.acpAvailableCommands = new Map();
  provider.promptQueue = { snapshot: () => [] };
  provider.permissionMessageForSession = () => null;
  provider.context = { globalState: { update: async () => {} } };
  provider.postState = () => posted.push(provider.stateMessage?.(session.id));
  provider.saveSessions = async () => {};
  return { provider, session, requests, posted };
}

(async () => {
  const { provider, session, requests, posted } = makeProvider();
  const initial = configOptions("high");

  // (a) session/new/session/resume state keeps the advertised values verbatim.
  provider.applyAcpSessionState(session, "acp-1", undefined, initial);
  assert.deepEqual(session.reasoningEffort, {
    currentValue: "high",
    options: initial[0].options
  });

  // (b) selecting an advertised value uses ACP's native session config method.
  await provider.updateSessionSettings(session.id, {
    mode: "Auto",
    model: "route-1",
    reasoningEffort: "ultra"
  });
  assert.deepEqual(requests, [{
    method: "session/set_config_option",
    params: { sessionId: "acp-1", configId: "thought_level", value: "ultra" }
  }]);
  assert.equal(session.reasoningEffort.currentValue, "ultra");

  // (c) the server notification becomes the displayed value; there is no
  // client-side optimistic value to mask a different server response.
  provider.applyAcpConfigOptionUpdate("acp-1", configOptions("default"));
  assert.equal(session.reasoningEffort.currentValue, "default");
  assert.ok(posted.length >= 1, "config update must publish refreshed state");

  console.log("thought_level ACP wiring: 3 scenarios passed");
})()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { Module._load = originalLoad; });
