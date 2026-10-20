import { expect, test } from "bun:test";
import {
  parseFormSpec,
  prepareFormSubmission,
  backgroundWorkNextAction,
} from "../src/ai/ui";
test("numeric selections submit numbers and invalid values preserve field errors", () => {
  const form = parseFormSpec({
    title: "Search",
    fields: [
      {
        name: "limit",
        label: "Candidates",
        type: "select",
        valueType: "integer",
        options: ["3", "10"],
        required: true,
      },
    ],
    submit: {
      tool: "search",
      label: "Find candidates",
      input: { intakeId: null },
    },
  })!;
  expect(form).not.toBeNull();
  expect(prepareFormSubmission(form, { limit: "3" })).toEqual({
    ok: true,
    input: { intakeId: null, limit: 3 },
  });
  expect(prepareFormSubmission(form, { limit: "4" })).toMatchObject({
    ok: false,
  });
  expect(prepareFormSubmission(form, { limit: "" })).toMatchObject({
    ok: false,
  });
  expect(
    parseFormSpec({
      ...form,
      fields: [{ ...form.fields[0], valueType: "garbage" }],
    }),
  ).toBeNull();
});
test("top-up becomes continue only with confirmed funding, completed becomes results", () => {
  const work = {
    workId: "job",
    title: "Search",
    status: "paused" as const,
    pauseReason: "funding" as const,
    completedSteps: 1,
    totalSteps: 3,
    hasResults: true,
  };
  expect(backgroundWorkNextAction(work).kind).toBe("top_up");
  expect(
    backgroundWorkNextAction({ ...work, fundingConfirmed: true }).kind,
  ).toBe("continue");
  expect(backgroundWorkNextAction({ ...work, status: "completed" }).kind).toBe(
    "view_results",
  );
  expect(
    backgroundWorkNextAction({
      ...work,
      status: "unknown",
      fundingConfirmed: true,
    }).kind,
  ).toBe("check_status");
});
