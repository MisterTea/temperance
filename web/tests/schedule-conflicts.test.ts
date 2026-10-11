import { describe, expect, it } from "vitest";
import { scheduleConflicts } from "../src/components/profile-editor";

const weekdays = [1, 2, 3, 4, 5];

describe("schedule conflict preview", () => {
  it("reports windows that are active at the same time", () => {
    expect(
      scheduleConflicts([
        { name: "Homework", start: "16:00", end: "17:00", days: weekdays },
        { name: "Dinner", start: "16:30", end: "18:00", days: [1, 3] },
        { name: "Bedtime", start: "21:00", end: "07:00", days: [0, 1, 2] },
      ]),
    ).toEqual(["Homework and Dinner overlap on Mon, Wed"]);
  });

  it("follows overnight windows into the next day and across the week boundary", () => {
    expect(
      scheduleConflicts([
        { name: "Bedtime", start: "21:00", end: "07:00", days: [6] },
        { name: "Early", start: "06:00", end: "08:00", days: [0] },
      ]),
    ).toEqual(["Bedtime and Early overlap on Sun"]);
    expect(
      scheduleConflicts([
        { name: "Bedtime", start: "21:00", end: "07:00", days: [1] },
        { name: "Morning", start: "07:00", end: "08:00", days: [2] },
      ]),
    ).toEqual([]);
  });

  it("ignores unset or empty windows", () => {
    expect(
      scheduleConflicts([
        { name: "Bedtime", start: "", end: "", days: [0, 1] },
        { name: "Same", start: "10:00", end: "10:00", days: [0] },
        { name: "Homework", start: "09:00", end: "11:00", days: [0] },
      ]),
    ).toEqual([]);
  });
});
