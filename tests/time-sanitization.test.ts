import { describe, expect, it } from "vitest";
import { sanitizeTime } from "../src/repositories/onboarding.repo.js";

describe("approx_time sanitization", () => {
  it("keeps valid HH:MM:SS format", () => {
    expect(sanitizeTime("12:34:56")).toBe("12:34:56");
  });

  it("adds seconds to valid HH:MM format", () => {
    expect(sanitizeTime("12:34")).toBe("12:34:00");
  });

  it("pads single digit hours with a leading zero", () => {
    expect(sanitizeTime("9:30")).toBe("09:30:00");
    expect(sanitizeTime("09:30")).toBe("09:30:00");
  });

  it("extracts valid time from complex strings/ranges", () => {
    expect(sanitizeTime("12:00-14:00")).toBe("12:00:00");
    expect(sanitizeTime("9:45 AM")).toBe("09:45:00");
    expect(sanitizeTime("entreno a las 18:30")).toBe("18:30:00");
  });

  it("returns null for invalid/unparsable formats", () => {
    expect(sanitizeTime("tarde")).toBeNull();
    expect(sanitizeTime("mañana")).toBeNull();
    expect(sanitizeTime("20hs")).toBeNull();
    expect(sanitizeTime("")).toBeNull();
    expect(sanitizeTime(null)).toBeNull();
    expect(sanitizeTime(undefined)).toBeNull();
  });
});
