import { describe, expect, it } from "vitest";
import {
  formatBelowMinimumMessage,
  formatUnparseableVersionMessage,
  formatVersionMismatchWarning,
  isBelowMinimumVersion,
  isVerifiedVersion,
  parseVersionOutput,
  validateBinary,
  type BinaryLocation,
} from "../../extensions/sentrux/binary.ts";

describe("parseVersionOutput", () => {
  it("parses a plain version", () => {
    expect(parseVersionOutput("sentrux 0.5.7\n")).toEqual({
      major: 0,
      minor: 5,
      patch: 7,
      pro: false,
      raw: "sentrux 0.5.7",
    });
  });

  it("parses a (Pro) suffix", () => {
    const parsed = parseVersionOutput("sentrux 0.5.7 (Pro)\n");
    expect(parsed?.pro).toBe(true);
    expect(parsed).toMatchObject({ major: 0, minor: 5, patch: 7 });
  });

  it("tolerates trailing 'Update available' text", () => {
    const parsed = parseVersionOutput("sentrux 0.5.7\nUpdate available: sentrux 0.5.8 is available\n");
    expect(parsed).toMatchObject({ major: 0, minor: 5, patch: 7, pro: false });
  });

  it("returns undefined for unparseable output", () => {
    expect(parseVersionOutput("not a version string")).toBeUndefined();
    expect(parseVersionOutput("")).toBeUndefined();
  });
});

describe("version comparisons", () => {
  it("flags versions below 0.5.0", () => {
    expect(isBelowMinimumVersion(parseVersionOutput("sentrux 0.4.9")!)).toBe(true);
    expect(isBelowMinimumVersion(parseVersionOutput("sentrux 0.5.0")!)).toBe(false);
    expect(isBelowMinimumVersion(parseVersionOutput("sentrux 0.5.7")!)).toBe(false);
  });

  it("only 0.5.7 exactly is the verified version", () => {
    expect(isVerifiedVersion(parseVersionOutput("sentrux 0.5.7")!)).toBe(true);
    expect(isVerifiedVersion(parseVersionOutput("sentrux 0.5.8")!)).toBe(false);
    expect(isVerifiedVersion(parseVersionOutput("sentrux 0.6.0")!)).toBe(false);
  });
});

describe("validateBinary version classification", () => {
  const location: BinaryLocation = { path: "/opt/sentrux", source: "config" };

  it("accepts the plain verified version with no warning", async () => {
    const run = async () => ({ code: 0, stdout: "sentrux 0.5.7\n", stderr: "", timedOut: false, aborted: false });
    const status = await validateBinary(location, { run, platform: "linux" });
    expect(status.version).toMatchObject({ major: 0, minor: 5, patch: 7, pro: false });
    expect(status.versionWarning).toBeUndefined();
  });

  it("accepts the (Pro) suffix with no warning", async () => {
    const run = async () => ({ code: 0, stdout: "sentrux 0.5.7 (Pro)\n", stderr: "", timedOut: false, aborted: false });
    const status = await validateBinary(location, { run, platform: "linux" });
    expect(status.version.pro).toBe(true);
    expect(status.versionWarning).toBeUndefined();
  });

  it("accepts an 'Update available' trailer and parses the leading version line", async () => {
    const run = async () => ({
      code: 0,
      stdout: "sentrux 0.5.7\nUpdate available: sentrux 0.5.8 is available\n",
      stderr: "",
      timedOut: false,
      aborted: false,
    });
    const status = await validateBinary(location, { run, platform: "linux" });
    expect(status.version).toMatchObject({ major: 0, minor: 5, patch: 7 });
  });

  it("warns, but does not throw, for a version other than 0.5.7", async () => {
    const run = async () => ({ code: 0, stdout: "sentrux 0.5.8\n", stderr: "", timedOut: false, aborted: false });
    const status = await validateBinary(location, { run, platform: "linux" });
    expect(status.versionWarning).toBe(formatVersionMismatchWarning(parseVersionOutput("sentrux 0.5.8")!));
  });

  it("throws for versions below 0.5.0", async () => {
    const run = async () => ({ code: 0, stdout: "sentrux 0.4.9\n", stderr: "", timedOut: false, aborted: false });
    await expect(validateBinary(location, { run, platform: "linux" })).rejects.toThrow(
      formatBelowMinimumMessage(parseVersionOutput("sentrux 0.4.9")!),
    );
  });

  it("throws with the stdout and a stderr tail for unparseable output", async () => {
    const run = async () => ({ code: 1, stdout: "garbage\n", stderr: "line1\nline2\n", timedOut: false, aborted: false });
    await expect(validateBinary(location, { run, platform: "linux" })).rejects.toThrow(
      formatUnparseableVersionMessage("garbage\n", "line1\nline2\n"),
    );
  });
});
