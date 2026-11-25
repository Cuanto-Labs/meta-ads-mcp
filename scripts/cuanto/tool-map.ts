import { createServer } from "../../src/server.js";

// Prints the registered tool surface: `--json` for machines, a Markdown table otherwise.
// Used to keep FORK.md and the tenant guard allowlist in step with upstream.

type Registered = {
  annotations?: Record<string, unknown>;
  inputSchema?: { shape?: Record<string, unknown> } | undefined;
};

const ID_ARG = /(^|_)ids?$|^target_ad_set$|^object_story_id$|^updates$/;
const STATUS_BUDGET_ARG = /^(status|active_status|daily_budget|lifetime_budget|bid_amount|bid_strategy|budget_value|budget_value_type|spend_cap|is_adset_budget_sharing_enabled|updates|target_ad_set|execution_spec)$/;

const server = createServer() as unknown as { _registeredTools: Record<string, Registered> };
const rows = Object.entries(server._registeredTools).map(([name, t]) => {
  const a = t.annotations ?? {};
  const kind = a.readOnlyHint ? "read" : a.destructiveHint ? "delete" : a.idempotentHint === false ? "create" : "update";
  const args = Object.keys(t.inputSchema?.shape ?? {});
  return {
    name,
    kind,
    args,
    idArgs: args.filter((x) => ID_ARG.test(x)),
    statusBudgetArgs: args.filter((x) => STATUS_BUDGET_ARG.test(x)),
  };
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log("| tool | kind | id args | status/budget args |");
  console.log("|---|---|---|---|");
  for (const r of rows) {
    console.log(`| \`${r.name}\` | ${r.kind} | ${r.idArgs.join(", ")} | ${r.statusBudgetArgs.join(", ")} |`);
  }
  console.log(`\n${rows.length} tools.`);
}
