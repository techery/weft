import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DataPane } from "./OutputPane";

const result = {
  evidence: "journal.jsonl",
  kind: "decision",
  approved: true,
  findings: [{ file: "src/app.ts", severity: "high" }],
};

const schema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      title: "Decision kind",
      enum: ["decision", "finding"],
      description: "How this output should be journaled.",
    },
    approved: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          severity: { type: "string", enum: ["low", "high"] },
        },
      },
    },
    evidence: { type: "string" },
  },
};

describe("structured step output", () => {
  it("renders schema-labelled nested data by default, in schema property order", () => {
    render(
      <DataPane
        title="step output"
        note="schema-validated"
        value={result}
        schema={schema}
        lines={[]}
        streaming={false}
      />,
    );

    const output = screen.getByRole("region", { name: "step output" });
    expect(within(output).getByRole("button", { name: "Structured" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(output)
        .getAllByRole("term")
        .map((term) => term.textContent),
    ).toEqual([
      "Decision kindstring",
      "Approvedboolean",
      "Findingsarray",
      "Filestring",
      "Severitystring",
      "Evidencestring",
    ]);
    expect(within(output).getByText("How this output should be journaled.")).toBeInTheDocument();
    expect(within(output).getByText("Finding 1")).toBeInTheDocument();
    expect(within(output).getByText("src/app.ts")).toBeInTheDocument();
  });

  it("switches to exact formatted JSON and back with user input", async () => {
    const user = userEvent.setup();
    render(
      <DataPane
        title="step output"
        note="schema-validated"
        value={result}
        schema={schema}
        lines={[]}
        streaming={false}
      />,
    );

    const output = screen.getByRole("region", { name: "step output" });
    await user.click(within(output).getByRole("button", { name: "JSON" }));
    expect(within(output).getByRole("button", { name: "JSON" })).toHaveAttribute("aria-pressed", "true");
    expect(within(output).getByText('"kind": "decision",')).toBeInTheDocument();
    expect(within(output).getByText('"findings": [')).toBeInTheDocument();

    await user.click(within(output).getByRole("button", { name: "Structured" }));
    expect(within(output).getByText("Decision kind")).toBeInTheDocument();
    expect(within(output).queryByText('"kind": "decision",')).not.toBeInTheDocument();
  });

  it("collapses and restores nested fields and array records independently", async () => {
    const user = userEvent.setup();
    render(
      <DataPane
        title="step output"
        note="schema-validated"
        value={result}
        schema={schema}
        lines={[]}
        streaming={false}
      />,
    );

    const output = screen.getByRole("region", { name: "step output" });
    const findings = within(output).getByRole("button", { name: "Collapse Findings" });
    expect(findings).toHaveAttribute("aria-expanded", "true");

    await user.click(findings);
    expect(findings).toHaveAttribute("aria-expanded", "false");
    expect(within(output).queryByRole("button", { name: "Collapse Finding 1" })).not.toBeInTheDocument();

    await user.click(findings);
    const finding = within(output).getByRole("button", { name: "Collapse Finding 1" });
    await user.click(finding);
    expect(finding).toHaveAttribute("aria-expanded", "false");
    expect(within(output).queryByText("src/app.ts")).not.toBeInTheDocument();

    await user.click(finding);
    expect(within(output).getByText("src/app.ts")).toBeInTheDocument();
  });

  it("infers a structured view for legacy object outputs whose journal has no schema", () => {
    render(
      <DataPane
        title="step output"
        note="schema-validated"
        value={{ recorded_count: 13, summaryText: "complete" }}
        schema={null}
        lines={[]}
        streaming={false}
      />,
    );

    expect(screen.getByText("Recorded count")).toBeInTheDocument();
    expect(screen.getByText("Summary Text")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Data view" })).toBeInTheDocument();
  });

  it("keeps unstructured streaming text in the transcript view", () => {
    render(
      <DataPane
        title="step output · running"
        note=""
        value={undefined}
        schema={null}
        lines={["working…"]}
        streaming
      />,
    );

    expect(screen.getByText("working…")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Data view" })).not.toBeInTheDocument();
  });
});
