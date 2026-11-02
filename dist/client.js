window.__ModuleLoader__.load({id:"dsh-chatgpt-subscription",factory:(require)=>{var module={exports:{}};var exports=module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  ChatgptPlan: () => ChatgptPlan,
  PlanStatusRow: () => PlanStatusRow,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");

// src/plan-contract.ts
var PLAN_PROVIDER_ID = "openai-chatgpt";
var MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";
var PLAN_NOTICE = {
  title: "Using ChatGPT plan",
  account: "ChatGPT account",
  manageUsage: "Manage usage",
  body: "Requests use the ChatGPT account shown here and count toward its existing plan limits. Connecting this app does not add an allowance. Credits may be used if you allow them in ChatGPT Settings \u2192 Usage.",
  pricing: "An API cost estimate of zero is not a balance, free usage, or an unlimited allowance.",
  privacy: "Prompts and provided content are sent to OpenAI. store:false does not mean zero data retention.",
  signIn: "Manage sign-in with dsh-chatgpt login / logout after closing the running DSH service."
};

// src/client/index.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots", "modelDirectories"];
var rowStyle = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "6px 12px",
  minWidth: 0,
  padding: "6px 4px",
  fontSize: 12,
  color: "var(--dsw-alias-label-secondary)"
};
function PlanStatusRow() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: rowStyle, "data-chatgpt-plan-status": "", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: PLAN_NOTICE.title }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", { href: MANAGE_USAGE_URL, target: "_blank", rel: "noopener noreferrer", style: { color: "var(--dsw-alias-state-business-primary)" }, children: PLAN_NOTICE.manageUsage })
  ] });
}
function ChatgptPlan(props) {
  const directory = (0, import_react.useSyncExternalStore)(
    (listener) => props.directory.subscribe(listener),
    () => props.directory.getSnapshot(),
    () => props.directory.getSnapshot()
  );
  if (props.session.subagent !== null || directory.current?.provider !== PLAN_PROVIDER_ID) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("section", { style: {
    boxSizing: "border-box",
    minWidth: 0,
    width: "calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance))",
    maxWidth: "var(--dsh-composer-card-max-width)",
    marginInline: "auto"
  }, "aria-label": "ChatGPT plan usage", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PlanStatusRow, {}) });
}
function apply(ctx) {
  const models = ctx.modelDirectories;
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    id: "chatgpt-plan-status",
    order: 100,
    inject: (sessionId) => ({ directory: models.directoryFor(sessionId).store })
  }, ChatgptPlan));
}
return module.exports;}});
//# sourceMappingURL=client.js.map
