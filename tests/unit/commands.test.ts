import { describe, expect, it } from "vitest";
import { parseCommand } from "../../src/core/commands";

describe("command whitelist", () => {
  it("parses drink with units", () => {
    expect(parseCommand("drink 250", "ml")).toEqual({ kind: "drink", ml: 250 });
    expect(parseCommand("  DRINK   250ml ", "ml")).toEqual({ kind: "drink", ml: 250 });
    expect(parseCommand("drink 8oz", "ml")).toEqual({ kind: "drink", ml: 237 });
    expect(parseCommand("drink 8 oz", "ml")).toEqual({ kind: "drink", ml: 237 });
    expect(parseCommand("drink 8", "oz")).toEqual({ kind: "drink", ml: 237 });
  });
  it("rejects bad amounts", () => {
    expect(parseCommand("drink", "ml").kind).toBe("error");
    expect(parseCommand("drink 0", "ml").kind).toBe("error");
    expect(parseCommand("drink 2001", "ml").kind).toBe("error");
    expect(parseCommand("drink 12.5", "ml").kind).toBe("error");
    expect(parseCommand("drink -5", "ml").kind).toBe("error");
    expect(parseCommand("drink 1e3", "ml").kind).toBe("error");
  });
  it("parses the other commands and git aliases", () => {
    expect(parseCommand("status", "ml")).toEqual({ kind: "status" });
    expect(parseCommand("hydration status", "ml")).toEqual({ kind: "status" });
    expect(parseCommand("log", "ml")).toEqual({ kind: "log", oneline: false });
    expect(parseCommand("hydration log --oneline", "ml")).toEqual({ kind: "log", oneline: true });
    expect(parseCommand("streak", "ml")).toEqual({ kind: "streak" });
    expect(parseCommand("help", "ml")).toEqual({ kind: "help" });
  });
  it("anything else is help, never executed", () => {
    for (const s of ["rm -rf /", "eval(1)", "hydration push", "log --all", "<script>", "drink; ls", "status now", ""]) {
      const c = parseCommand(s, "ml");
      expect(["help", "error"]).toContain(c.kind);
    }
    expect(parseCommand("drink 250; rm", "ml").kind).toBe("error");
    expect(parseCommand("x".repeat(65), "ml").kind).toBe("error");
  });
});
