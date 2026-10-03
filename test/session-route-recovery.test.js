"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { requestSessionRoute } = require("../lib/session-route-recovery");
const pkg = require("../package.json");

(async () => {
  const calls = [];
  let confirmed = false;
  const request = async (method, params) => {
    calls.push({ method, params });
    if (!params._meta) throw new Error("route ambiguous");
    assert.equal(confirmed, true);
    return { models: { currentModelId: "custom:baqis-fast:qwen-test" } };
  };
  const result = await requestSessionRoute({request, method: "session/resume",
    params: {sessionId: "old", cwd: ".", mcpServers: []},
    chooseRoute: async () => { confirmed = true; return "custom:baqis-fast:qwen-test"; }});
  assert.equal(result.selectedModel, "custom:baqis-fast:qwen-test");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.method === "session/resume" && c.params.sessionId === "old"));
  assert.equal(calls[1].params._meta.hermesModelId, result.selectedModel);

  let count = 0;
  await assert.rejects(requestSessionRoute({
    request: async () => { count++; throw new Error("ambiguous"); },
    method: "session/resume", params: {sessionId: "old"}, chooseRoute: async () => undefined
  }), e => e.code === "HERMES_SESSION_ROUTE_BLOCKED");
  assert.equal(count, 1);

  await assert.rejects(requestSessionRoute({
    request: async (method, params) => {
      if (!params._meta) throw new Error("ambiguous");
      return {models: {currentModelId: "custom:baqis:qwen-test"}};
    }, method: "session/resume", params: {sessionId: "old"},
    chooseRoute: async () => "custom:baqis-fast:qwen-test"
  }), e => e.code === "HERMES_SESSION_ROUTE_BLOCKED");

  let chooses = 0;
  const ready = await requestSessionRoute({
    request: async () => ({models: {currentModelId: "custom:cpa:gpt-test"}}),
    method: "session/resume", params: {sessionId: "old"},
    chooseRoute: async () => { chooses++; return "custom:cpa:gpt-test"; }
  });
  assert.equal(chooses, 0);
  assert.equal(ready.selectedModel, undefined);
  // Wiring: the dedicated recovery checks must be runnable standalone and the
  // existing chains must cover both recovery tests (lint) and this test (run).
  {
    assert.equal(typeof pkg.scripts["lint:recovery"], "string", "lint:recovery script must exist");
    assert.equal(typeof pkg.scripts["test:recovery"], "string", "test:recovery script must exist");
    assert.ok(pkg.scripts["lint:recovery"].includes("node --check " + path.join("lib", "session-route-recovery.js").split(path.sep).join("/")), "lint:recovery must node --check lib/session-route-recovery.js");
    assert.ok(pkg.scripts["lint:recovery"].includes(path.join("test", "session-route-recovery.test.js").split(path.sep).join("/")), "lint:recovery must node --check this test");
    assert.ok(pkg.scripts["lint:recovery"].includes(path.join("test", "session-route-recovery-extension.test.js").split(path.sep).join("/")), "lint:recovery must node --check the extension wiring test");
    assert.ok(pkg.scripts["lint:recovery"].includes(path.join("extension.js").split(path.sep).join("/")), "lint:recovery must node --check extension.js");
    assert.ok(pkg.scripts["lint:recovery"].includes(path.join("package.json")), "lint:recovery must also check package.json (kept in sync with this assertion)");
    assert.ok(pkg.scripts["test:recovery"].includes(path.join("test", "session-route-recovery.test.js").split(path.sep).join("/")), "test:recovery must run this test");
    assert.ok(pkg.scripts["test:recovery"].includes(path.join("test", "session-route-recovery-extension.test.js").split(path.sep).join("/")), "test:recovery must run the extension wiring test");
    // The wiring test is a new unit: it joins the lint chain and gets a
    // dedicated entry in test:unit (the historical run order is preserved).
    assert.ok(pkg.scripts.lint.includes(path.join("test", "session-route-recovery-extension.test.js").split(path.sep).join("/")), "lint must node --check the extension wiring test");
    assert.ok(pkg.scripts["test:unit"].includes(path.join("test", "session-route-recovery-extension.test.js").split(path.sep).join("/")), "test:unit must run the extension wiring test");
    assert.ok(pkg.scripts["test:unit"].includes(path.join("test", "session-route-recovery.test.js").split(path.sep).join("/")), "test:unit must keep running this test");
  }

  let cancelled = false;
  let lateCalls = 0;
  await assert.rejects(requestSessionRoute({
    request: async (method, params) => {
      lateCalls++;
      if (!params._meta) throw new Error("ambiguous");
      cancelled = true; // /stop lands after dispatch, before the reply is handled.
      return {models: {currentModelId: "custom:baqis-fast:qwen-test"}};
    },
    method: "session/resume", params: {sessionId: "old"},
    chooseRoute: async () => "custom:baqis-fast:qwen-test",
    isCancelled: () => cancelled
  }), e => e.code === "HERMES_TURN_CANCELLED");
  assert.equal(lateCalls, 2); // A dispatched request cannot be undone.

  console.log("session route recovery: 5 scenarios passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
