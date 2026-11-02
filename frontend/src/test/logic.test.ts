import { describe, expect, it } from "vitest";
import { filterToQuery } from "../lib/api";
import { describeChange, isOverdue } from "../lib/format";
import type { Issue } from "../lib/types";
import { resolveDrop } from "../pages/Board";

const issue = (id: number, statusId: number, rank: number) =>
  ({ id, rank, status: { id: statusId, name: `S${statusId}`, category: "todo", position: 0, wip_limit: null } }) as unknown as Issue;

describe("resolveDrop", () => {
  // column 1: A(1) B(2) C(3); column 2: D(4)
  const issues = [issue(1, 1, 100), issue(2, 1, 200), issue(3, 1, 300), issue(4, 2, 100)];

  it("dropping on an empty column area appends at the bottom", () => {
    expect(resolveDrop(issues, 1, { type: "column", statusId: 2 })).toEqual({ statusId: 2, aboveId: 4, belowId: null });
  });
  it("dropping onto a card in another column inserts above it", () => {
    expect(resolveDrop(issues, 2, { type: "card", issueId: 4 })).toEqual({ statusId: 2, aboveId: null, belowId: 4 });
  });
  it("moving down within a column lands after the hovered card", () => {
    expect(resolveDrop(issues, 1, { type: "card", issueId: 2 })).toEqual({ statusId: 1, aboveId: 2, belowId: 3 });
  });
  it("moving up within a column lands before the hovered card", () => {
    expect(resolveDrop(issues, 3, { type: "card", issueId: 1 })).toEqual({ statusId: 1, aboveId: null, belowId: 1 });
  });
  it("respects swimlanes by ignoring cards in other lanes", () => {
    expect(resolveDrop(issues, 1, { type: "column", statusId: 1 }, (i) => i.id !== 3)).toEqual({ statusId: 1, aboveId: 2, belowId: null });
  });
  it("returns null for unknown issues", () => {
    expect(resolveDrop(issues, 99, { type: "column", statusId: 1 })).toBeNull();
  });
});

describe("filterToQuery", () => {
  it("repeats array params and drops empty values", () => {
    expect(filterToQuery({ status_ids: [1, 2], text: "", labels: [], overdue: true }, { page: 2 }))
      .toBe("?status_ids=1&status_ids=2&overdue=true&page=2");
  });
  it("encodes TQL safely", () => {
    expect(filterToQuery({ tql: 'summary ~ "a&b"' })).toBe("?tql=summary+%7E+%22a%26b%22");
  });
  it("returns an empty string for no filters", () => {
    expect(filterToQuery({})).toBe("");
  });
});

describe("format helpers", () => {
  it("describes history entries", () => {
    expect(describeChange({ field: "status", old_value: "To Do", new_value: "Done" })).toBe("changed Status: To Do → Done");
    expect(describeChange({ field: "assignee", old_value: null, new_value: "Sam" })).toBe("set Assignee to Sam");
    expect(describeChange({ field: "created", old_value: null, new_value: "X-1" })).toBe("created the issue");
  });
  it("never marks done work as overdue", () => {
    expect(isOverdue("2020-01-01", "done")).toBe(false);
    expect(isOverdue("2020-01-01", "todo")).toBe(true);
    expect(isOverdue("2999-01-01", "todo")).toBe(false);
  });
});
