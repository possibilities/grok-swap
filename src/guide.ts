import { VERSION } from "./version.ts";
import { ERROR_CODES, type ErrorCatalogEntry } from "./error-catalog.ts";

interface Argument {
  name: string;
  type: "string" | "boolean" | "integer" | "number";
  description: string;
  format?: "path" | "url" | "duration" | "ref" | "json";
  required?: boolean;
  positional?: boolean;
  choices?: string[];
  default?: unknown;
  role?: "call" | "output-format" | "store-selection" | "meta";
  minimum?: number;
  maximum?: number;
  aliases?: string[];
}

interface Command {
  name: string;
  summary: string;
  audience: "agent" | "operator" | "internal";
  mutates: boolean;
  arguments: Argument[];
  blocking?: boolean;
  aliases?: string[];
  examples?: Array<{ invocation: string; description: string }>;
  constraints?: Array<{
    kind: "one_of" | "at_least_one" | "conflicts" | "requires";
    arguments: string[];
    required?: boolean;
    description?: string;
  }>;
}

interface Contract {
  contract_version: 1;
  meta: { name: string; version: string; purpose: string; audience: "agent" };
  guidance: string;
  concepts: {
    model: Record<string, unknown>;
    output_contract: { envelope: Record<string, unknown>; exit_codes: Record<string, string> };
    error_codes: readonly ErrorCatalogEntry[];
  };
  global_arguments: Argument[];
  commands: Command[];
}

const ACCOUNT: Argument = {
  name: "account",
  type: "string",
  description: "Stable grok-N key, unique alias, or unique email.",
  positional: true,
  required: true,
  format: "ref",
};

export const CONTRACT: Contract = {
  contract_version: 1,
  meta: {
    name: "grok-swap",
    version: VERSION,
    purpose: "Own multiple xAI OAuth accounts, observe Grok billing usage, and make reservation-aware account selections without activating or launching a harness.",
    audience: "agent",
  },
  guidance: "Use list or observe for secret-free account display, refresh to bypass billing backoff, and select to obtain a fail-closed balancing decision. Selection only returns an account identity and optional short reservation; it never activates credentials or starts a Grok harness. Prefer accountKey over aliases or email in automation.",
  concepts: {
    model: {
      accountKey: "Immutable grok-N identity; ordinals are never recycled.",
      observation: "Last-good billing survives transient failures. Observations older than 24 hours are not decision-grade.",
      selection: "Included allowance outranks prepaid credit, which outranks PAYG. Unknown usage requires --allow-unknown.",
      reservation: "A successful non-dry selection excludes its account from other decisions for 1-300 seconds.",
      activation: "Out of scope. The selected account is not installed into Grok Build or any harness.",
    },
    output_contract: {
      envelope: {
        schema_version: 1,
        ok: "boolean",
        command: "string",
        provider: "grok",
        generatedAt: "ISO 8601 UTC",
        data: "command result or null",
        error: "null or {code,message,details?}",
      },
      exit_codes: { "0": "success", "1": "operational failure", "2": "invalid call or unresolved account", "3": "selection refusal" },
    },
    error_codes: ERROR_CODES,
  },
  global_arguments: [
    { name: "--json", type: "boolean", description: "Emit one stable schema_version envelope.", role: "output-format" },
    { name: "--help", type: "boolean", description: "Render help from this contract.", aliases: ["-h"], role: "meta" },
  ],
  commands: [
    {
      name: "add",
      summary: "Sign in to one xAI account and add it with the next immutable grok-N identity",
      audience: "operator",
      mutates: true,
      blocking: true,
      arguments: [
        { name: "--alias", type: "string", description: "Optional mutable human label." },
        { name: "--no-open", type: "boolean", description: "Print the device URL and code without trying to open a browser." },
      ],
      examples: [{ invocation: "grok-swap add --alias personal", description: "Complete xAI device authorization and create the account." }],
    },
    { name: "list", summary: "List secret-free account metadata without network access", audience: "agent", mutates: false, arguments: [] },
    { name: "observe", summary: "Observe enabled accounts, respecting retry backoff", audience: "agent", mutates: true, arguments: [] },
    {
      name: "refresh",
      summary: "Force a billing observation for all enabled accounts or one exact account",
      audience: "agent",
      mutates: true,
      arguments: [{ name: "--account", type: "string", description: "Limit refresh to one account.", format: "ref" }],
    },
    {
      name: "select",
      summary: "Choose and normally reserve one eligible account without activating it",
      audience: "agent",
      mutates: true,
      arguments: [
        { name: "strategy", type: "string", description: "Compatibility positional: best, next-available, or an account reference.", positional: true },
        { name: "--mode", type: "string", description: "Automatic selection strategy.", choices: ["best", "next-available"], default: "best" },
        { name: "--account", type: "string", description: "Fail-closed selection of this exact account.", format: "ref" },
        { name: "--allow-unknown", type: "boolean", description: "Permit an account without decision-grade billing data." },
        { name: "--dry-run", type: "boolean", description: "Preview without a reservation or cursor change." },
        { name: "--reserve-seconds", type: "integer", description: "Reservation lifetime.", default: 30, minimum: 1, maximum: 300 },
      ],
      constraints: [{ kind: "conflicts", arguments: ["--mode", "--account", "strategy"], description: "Use only one way to state the selection target." }],
      examples: [
        { invocation: "grok-swap select --mode best --json", description: "Prefer included allowance and reserve the winner." },
        { invocation: "grok-swap select --account grok-2 --dry-run --json", description: "Check one account without falling back or reserving it." },
      ],
    },
    { name: "remove", summary: "Delete one locally owned account and its reservations", audience: "operator", mutates: true, arguments: [ACCOUNT] },
    {
      name: "alias",
      summary: "Set or clear one account alias",
      audience: "operator",
      mutates: true,
      arguments: [
        ACCOUNT,
        { name: "alias", type: "string", description: "New alias.", positional: true },
        { name: "--clear", type: "boolean", description: "Clear the alias." },
      ],
      constraints: [{ kind: "one_of", arguments: ["alias", "--clear"], required: true }],
    },
    { name: "enable", summary: "Enable one account for observation and selection", audience: "operator", mutates: true, arguments: [ACCOUNT] },
    { name: "disable", summary: "Disable one account and clear its reservations", audience: "operator", mutates: true, arguments: [ACCOUNT] },
    { name: "guide", summary: "Emit this canonical command contract", audience: "agent", mutates: false, arguments: [] },
    { name: "help", summary: "Render human help from the canonical contract", audience: "operator", mutates: false, arguments: [], aliases: ["--help", "-h"] },
    { name: "version", summary: "Print the installed version", audience: "operator", mutates: false, arguments: [], aliases: ["--version"] },
  ],
};

function argumentToken(argument: Argument): string {
  if (argument.positional) {
    const name = argument.choices?.join("|") ?? argument.name;
    return argument.required ? `<${name}>` : `[${name}]`;
  }
  const value = argument.type === "boolean" ? "" : ` <${argument.choices?.join("|") ?? argument.name.slice(2)}>`;
  return argument.required ? `${argument.name}${value}` : `[${argument.name}${value}]`;
}

export function renderHelp(): string {
  const lines = [`grok-swap ${VERSION} — ${CONTRACT.meta.purpose}`, "", "Usage:"];
  for (const command of CONTRACT.commands) {
    if (command.name === "help" || command.name === "version") continue;
    lines.push(`  grok-swap ${command.name}${command.arguments.length ? ` ${command.arguments.map(argumentToken).join(" ")}` : ""}`);
  }
  lines.push("", "Every command accepts --json. Selection does not activate or launch a Grok harness.", "Full contract: grok-swap guide --json");
  return lines.join("\n");
}

export function renderAgentHelp(): string {
  const lines = [`${CONTRACT.meta.name} ${VERSION} — ${CONTRACT.meta.purpose}`, ""];
  for (const command of CONTRACT.commands) {
    lines.push(`${command.name} — ${command.summary} (mutates: ${command.mutates})`);
    for (const argument of command.arguments) lines.push(`  ${argument.name} (${argument.type}) — ${argument.description}`);
  }
  lines.push("", "Full machine-readable contract: grok-swap guide --json");
  return lines.join("\n");
}

export function renderAgentTeaser(): string {
  return `grok-swap — ${CONTRACT.meta.purpose} Run \`grok-swap guide --json\` for the full contract.`;
}
