"use strict";

// Explicit route recovery for a persisted ACP session.
//
// A resume that fails (e.g. the backend refuses an ambiguous route) must NOT
// be "fixed" by creating a replacement session or by falling back to the CLI.
// The only recovery is a single retry with an explicitly user-confirmed named
// model id (`custom:<provider>:<model>`) passed via the private
// `_meta.hermesModelId` field. If the user declines, or if the backend does
// not echo back exactly the chosen id, the failure is reported with the
// dedicated HERMES_SESSION_ROUTE_BLOCKED code so callers keep the original
// session id untouched.
//
// Deliberate non-goals (kept here so a future edit doesn't drift):
// - No error-string parsing. Any failure of the first request triggers the
//   choice; the original error is carried only as `cause` and never logged.
// - No reliance on the background host preserving error.data.
// - No retry loop: at most one user-confirmed retry.

const NAMED_ROUTE = /^custom:[^:]+:.+$/;

async function requestSessionRoute({ request, method, params, chooseRoute }) {
  try {
    return { response: await request(method, params), selectedModel: undefined };
  } catch (original) {
    try {
      const modelId = await chooseRoute();
      if (typeof modelId !== "string" || !NAMED_ROUTE.test(modelId)) throw original;
      const response = await request(method, {
        ...params, _meta: { ...(params._meta || {}), hermesModelId: modelId }
      });
      const current = response?.models?.currentModelId || response?.models?.current_model_id;
      if (current !== modelId) throw new Error("The backend did not confirm the selected route.");
      return { response, selectedModel: modelId };
    } catch (cause) {
      const error = new Error("Hermes could not initialize this session on a confirmed route. The existing session was not replaced.");
      error.code = "HERMES_SESSION_ROUTE_BLOCKED";
      error.cause = cause;
      throw error;
    }
  }
}

module.exports = { requestSessionRoute };
