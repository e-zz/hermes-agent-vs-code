"use strict";
const assert = require("node:assert/strict");
const { requestSessionRoute } = require("../lib/session-route-recovery");

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
  console.log("session route recovery: 4 scenarios passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
