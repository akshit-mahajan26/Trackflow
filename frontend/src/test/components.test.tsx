import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChartCard } from "../components/charts";
import { ConfirmDialog, Field, Input } from "../components/ui";
import { ThemeProvider } from "../lib/theme";

describe("Field", () => {
  it("associates its label with the control", () => {
    render(<Field label="Summary" required><Input /></Field>);
    expect(screen.getByLabelText(/Summary/)).toBeInstanceOf(HTMLInputElement);
  });
});

describe("ConfirmDialog", () => {
  it("calls onConfirm and onClose", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog open title="Delete it?" message="Sure?" confirmLabel="Delete" danger onConfirm={onConfirm} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<ConfirmDialog open title="T" message="M" onConfirm={() => {}} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ChartCard", () => {
  it("offers a table view of the same rows", async () => {
    window.matchMedia ??= (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
    render(
      <ThemeProvider>
        <ChartCard title="Velocity" rows={[{ name: "Sprint 1", done: 5 }]} columns={[{ key: "name", label: "Sprint" }, { key: "done", label: "Done" }]}>
          <div>chart-body</div>
        </ChartCard>
      </ThemeProvider>,
    );
    expect(screen.getByText("chart-body")).toBeInTheDocument();
    await userEvent.click(screen.getByTitle("Table view"));
    expect(screen.getByRole("columnheader", { name: "Sprint" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Sprint 1" })).toBeInTheDocument();
  });
});

describe("Modal focus", () => {
  // Regression: an inline onClose re-created on each keystroke used to re-run the focus effect,
  // moving focus to the header close button after every character typed.
  it("keeps focus in the confirmation field while typing", async () => {
    const { useState } = await import("react");
    function Parent() {
      const [value, setValue] = useState("");
      return (
        <ConfirmDialog open title="Delete project?" message="Type the key" onConfirm={() => {}} onClose={() => setValue("")}>
          <Input aria-label="Confirm key" value={value} onChange={(e) => setValue(e.target.value)} />
        </ConfirmDialog>
      );
    }
    render(<Parent />);
    const input = screen.getByLabelText("Confirm key");
    expect(input).toHaveFocus(); // first field in the body, not the close button
    await userEvent.keyboard("WEB");
    expect(input).toHaveValue("WEB");
    expect(input).toHaveFocus();
  });

  it("does not override a field that uses autoFocus", () => {
    render(
      <ConfirmDialog open title="T" message="M" onConfirm={() => {}} onClose={() => {}}>
        <Input aria-label="first" />
        <Input aria-label="second" autoFocus />
      </ConfirmDialog>,
    );
    expect(screen.getByLabelText("second")).toHaveFocus();
  });

  it("focuses the primary action when there is no field", () => {
    render(<ConfirmDialog open title="T" message="M" confirmLabel="Go" onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });
});
