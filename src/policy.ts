import type { Rule, ExecutionInput } from "../shared/api.js";
export const demoRules: Rule[] = [
  {
    id: "status",
    enabled: true,
    tool: "*",
    matcher: "exact",
    value: "git status",
    action: "permit",
  },
  {
    id: "push-review",
    enabled: true,
    tool: "*",
    matcher: "prefix",
    value: "git push",
    action: "approval",
  },
  {
    id: "synthetic-destruction",
    enabled: true,
    tool: "*",
    matcher: "prefix",
    value: "testigo-demo destroy",
    action: "deny",
  },
];
export function evaluate(rules: Rule[], input: ExecutionInput) {
  const command = input.arguments.command;
  const matches = rules.filter(
    (r) =>
      r.enabled &&
      (r.tool === "*" || r.tool === input.tool) &&
      (r.matcher === "exact"
        ? command === r.value
        : command === r.value ||
          (command.startsWith(r.value) &&
            /[\s;&|<>]/u.test(command[r.value.length] ?? ""))),
  );
  const action = matches.some((r) => r.action === "deny")
    ? "deny"
    : matches.some((r) => r.action === "approval")
      ? "approval"
      : matches.some((r) => r.action === "permit")
        ? "permit"
        : "approval";
  return { action, matches: matches.map((r) => r.id) };
}
