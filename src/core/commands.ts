// The command bar accepts a fixed whitelist. Input is never evaluated,
// executed or passed to a shell; anything unknown just shows help.

import { parseAmount } from "./units";
import type { Unit } from "./types";

export type Command =
  | { kind: "drink"; ml: number }
  | { kind: "status" }
  | { kind: "log"; oneline: boolean }
  | { kind: "streak" }
  | { kind: "help" }
  | { kind: "error"; message: string };

export const MAX_COMMAND_LENGTH = 64;

export const HELP_LINES = [
  "commands:",
  "  drink <amount>          log water, e.g. drink 250 or drink 8oz",
  "  status                  today's progress and byte's mood",
  "  log [--oneline]         today's commits",
  "  streak                  current and best streak",
  "  hydration log|status    same as above, git style",
  "  help                    this list",
];

export function parseCommand(input: string, unit: Unit): Command {
  if (input.length > MAX_COMMAND_LENGTH) return { kind: "error", message: "command too long" };
  let words = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kind: "help" };
  if (words[0] === "hydration") {
    words = words.slice(1);
    if (words.length === 0) return { kind: "help" };
    if (words[0] !== "log" && words[0] !== "status") return { kind: "help" };
  }
  const [cmd, ...args] = words;
  switch (cmd) {
    case "drink": {
      if (args.length === 0) return { kind: "error", message: "usage: drink <amount>, e.g. drink 250" };
      const r = parseAmount(args.join(""), unit);
      return r.ok ? { kind: "drink", ml: r.ml } : { kind: "error", message: r.error };
    }
    case "status":
      return args.length ? { kind: "help" } : { kind: "status" };
    case "log":
      if (args.length === 0) return { kind: "log", oneline: false };
      if (args.length === 1 && args[0] === "--oneline") return { kind: "log", oneline: true };
      return { kind: "help" };
    case "streak":
      return args.length ? { kind: "help" } : { kind: "streak" };
    case "help":
      return { kind: "help" };
    default:
      return { kind: "help" };
  }
}
