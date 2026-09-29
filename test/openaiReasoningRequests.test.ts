import { expect, test } from "bun:test";
import { buildResponsesRequestBody } from "../src/ai/providers/openaiResponses";

const optionalQuery = {
  properties: { path: { type: "string" }, query: { type: "string" } },
  required: ["path"],
  type: "object",
};
const strictQuery = {
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    ranges: {
      items: {
        additionalProperties: false,
        properties: { end: { type: "number" }, start: { type: "number" } },
        required: ["start", "end"],
        type: "object",
      },
      type: "array",
    },
  },
  required: ["path", "ranges"],
  type: "object",
};
const toolsIn = (body: Record<string, unknown>) =>
  body.tools as Array<Record<string, unknown>>;

test("reasoning models get no sampling parameters", () => {
  const body = buildResponsesRequestBody(
    {
      messages: [{ content: "hi", role: "user" }],
      model: "gpt-6-astra",
      temperature: 0,
      topP: 0.9,
    },
    false,
  );
  expect(body.temperature).toBeUndefined();
  expect(body.top_p).toBeUndefined();
});

test("non-reasoning models keep their sampling parameters", () => {
  const body = buildResponsesRequestBody(
    {
      messages: [{ content: "hi", role: "user" }],
      model: "gpt-4.1",
      temperature: 0,
      topP: 0.9,
    },
    false,
  );
  expect(body.temperature).toBe(0);
  expect(body.top_p).toBe(0.9);
});

test("tools with optional properties are sent non-strict", () => {
  const body = buildResponsesRequestBody(
    {
      messages: [{ content: "hi", role: "user" }],
      model: "gpt-6-astra",
      tools: [
        { description: "read", input_schema: optionalQuery, name: "read" },
        { description: "slice", input_schema: strictQuery, name: "slice" },
        {
          description: "nested",
          input_schema: {
            ...strictQuery,
            properties: {
              ...strictQuery.properties,
              ranges: { items: optionalQuery, type: "array" },
            },
          },
          name: "nested",
        },
      ],
    },
    false,
  );
  expect(toolsIn(body).map((tool) => [tool.name, tool.strict])).toEqual([
    ["read", false],
    ["slice", true],
    ["nested", false],
  ]);
});

test("replayed tool calls carry no output item id", () => {
  const body = buildResponsesRequestBody(
    {
      messages: [
        {
          content: [
            {
              id: "call_1",
              input: { path: "a.ts" },
              name: "read",
              providerData: {
                arguments: '{"path":"a.ts"}',
                call_id: "call_1",
                id: "fc_1",
                name: "read",
                status: "completed",
                type: "function_call",
              },
              type: "tool_use",
            },
          ],
          role: "assistant",
        },
        {
          content: [
            { content: "ok", tool_use_id: "call_1", type: "tool_result" },
          ],
          role: "user",
        },
      ],
      model: "gpt-6-astra",
    },
    false,
  );
  const call = (body.input as Array<Record<string, unknown>>).find(
    (item) => item.type === "function_call",
  );
  expect(call).toEqual({
    arguments: '{"path":"a.ts"}',
    call_id: "call_1",
    name: "read",
    status: "completed",
    type: "function_call",
  });
});
