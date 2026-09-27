import { describe, expect, it } from "vitest";
import { warmupFailureStatus } from "../../extensions/sentrux/index.ts";

describe("warmupFailureStatus (§6.6)", () => {
  it("maps the not-found error to 'sentrux: not found'", () => {
    expect(warmupFailureStatus(new Error("Sentrux binary not found. Install v0.5.7"))).toBe("sentrux: not found");
  });

  it("maps the GTK/X11 loader error to 'sentrux: missing libs'", () => {
    expect(
      warmupFailureStatus(
        new Error("Sentrux cannot start: its Linux release binary links GTK3/X11 libraries even for CLI/MCP use, and `libgtk-3.so` is missing."),
      ),
    ).toBe("sentrux: missing libs");
  });

  it("maps a non-executable binary to 'sentrux: not executable', not 'missing libs'", () => {
    expect(warmupFailureStatus(new Error("`/bin/sentrux` is not executable (chmod +x)."))).toBe("sentrux: not executable");
  });
});
