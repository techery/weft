import { describe, expect, it } from "vitest";
import { proxiedOrigin } from "./proxy-origin";

const DAEMON = "http://127.0.0.1:4781";

describe("dev API proxy origin", () => {
  it("translates the Vite page origin to the daemon origin", () => {
    expect(proxiedOrigin("http://localhost:4782", "localhost:4782", DAEMON)).toBe(DAEMON);
  });

  it("does not launder a foreign or malformed origin", () => {
    expect(proxiedOrigin("https://attacker.example", "localhost:4782", DAEMON)).toBe(
      "https://attacker.example",
    );
    expect(proxiedOrigin("not a URL", "localhost:4782", DAEMON)).toBe("not a URL");
  });

  it("leaves non-browser requests without an Origin alone", () => {
    expect(proxiedOrigin(undefined, "localhost:4782", DAEMON)).toBeUndefined();
  });
});
