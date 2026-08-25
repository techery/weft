import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Finding } from "~/domain/types";
import { FindingCard } from "./FindingCard";

const finding = (msg: string): Finding => ({
  id: "n-1",
  msg,
  loc: "",
  sev: "decision",
  stepLabel: "",
  chip: "",
  settled: true,
});

describe("FindingCard", () => {
  it("preserves authored newlines and formats inline code", () => {
    const { container } = render(
      <FindingCard finding={finding("State boundary: `src/state/todos.ts`\nEvery view uses its atoms.")} />,
    );

    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(screen.getByText("src/state/todos.ts").tagName).toBe("CODE");
  });

  it("breaks a long single-line note into readable sentences", () => {
    const longLead =
      "The state boundary owns every persisted atom and all derived application state. ".repeat(3);
    const { container } = render(
      <FindingCard finding={finding(`${longLead}Every view uses those atoms.`)} />,
    );

    expect(container.querySelectorAll("p").length).toBeGreaterThan(1);
    expect(screen.getByText("Every view uses those atoms.")).toBeInTheDocument();
  });
});
