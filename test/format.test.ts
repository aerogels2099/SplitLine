import { describe, expect, it } from "vitest";
import { fmtAgo } from "../web/src/format.js";

const NOW = 1_800_000_000;
const ago = (seconds: number) => fmtAgo(NOW - seconds, NOW);
const DAY = 86_400;

describe("fmtAgo", () => {
  it("rounds down within each unit", () => {
    expect(ago(0)).toBe("now");
    expect(ago(59)).toBe("now");
    expect(ago(60)).toBe("1m");
    expect(ago(3599)).toBe("59m");
    expect(ago(3600)).toBe("1h");
    expect(ago(DAY - 1)).toBe("23h");
    expect(ago(DAY)).toBe("1d");
    expect(ago(30 * DAY - 1)).toBe("29d");
    expect(ago(30 * DAY)).toBe("1mo");
  });

  it("keeps counting months past a year", () => {
    expect(ago(400 * DAY)).toBe("13mo");
  });

  it("reads a date slightly ahead of the clock as now", () => {
    expect(ago(-5)).toBe("now");
  });
});
