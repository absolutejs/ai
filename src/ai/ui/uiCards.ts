import type { AIToolMap } from "../../../types/ai";

/**
 * UI cards — the generative-UI primitive extracted from onSpark's chat.
 *
 * A "card" is a schema-only tool: the model calls it with a structured payload,
 * the handler validates before ACKNOWLEDGING (steering the model's continuation), and the
 * host watches the executed tool calls to render the payload as a real,
 * host-styled component (a chart, a table, an approval card, a deep link…).
 * No model-written code ever executes: the payload is validated by the card's
 * `parse` before success is reported. Invalid calls return a tool error so the
 * model can repair them; the collector also excludes invalid payloads.
 */
export class UiCardValidationError extends Error {
  readonly card: string;

  constructor(card: string) {
    super(
      `UI card "${card}" was not rendered: input failed validation. Correct the input to match the tool schema and retry.`,
    );
    this.name = "UiCardValidationError";
    this.card = card;
  }
}

export type UiCardDefinition<T = unknown> = {
  /** Tool name the model calls, e.g. "render_chart". */
  name: string;
  /** Tool description — steer WHEN the model should render this card. */
  description: string;
  /** JSON schema for the tool input. */
  inputSchema: Record<string, unknown>;
  /** Tool-result text fed back to the model (e.g. "(chart rendered — don't
   *  repeat its numbers in text)"). */
  ack: string;
  /** Validate + narrow the raw model input to the card payload. Return null
   *  to reject the call with a tool error. Keep this pure: it runs during
   *  tool execution and again when collecting cards for rendering. */
  parse: (input: unknown) => T | null;
};

export type UiCardEvent = {
  /** The card's tool name. */
  card: string;
  /** The parsed, validated payload. */
  data: unknown;
};

export type UiCards = {
  /** AIToolMap entries (ack handlers) — spread into the tools you hand to
   *  streamAIWithTools / generateAIWithTools. */
  tools: AIToolMap;
  /** Pull validated card events out of a turn's tool calls, in call order.
   *  Invalid payloads and non-card tools are skipped. */
  collect: (
    calls: readonly { name: string; input: unknown }[],
  ) => UiCardEvent[];
  /** Is this tool name one of the registered cards? */
  has: (name: string) => boolean;
};

/** Build the tool map + collector for a set of UI cards. */
export const createUiCards = (
  definitions: readonly UiCardDefinition[],
): UiCards => {
  const byName = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );

  const tools: AIToolMap = Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      {
        description: definition.description,
        handler: async (input) => {
          if (definition.parse(input) === null) {
            throw new UiCardValidationError(definition.name);
          }

          return definition.ack;
        },
        input: definition.inputSchema,
      },
    ]),
  );

  const collect = (calls: readonly { name: string; input: unknown }[]) => {
    const events: UiCardEvent[] = [];
    for (const call of calls) {
      const definition = byName.get(call.name);
      if (!definition) continue;
      const data = definition.parse(call.input);
      if (data !== null) events.push({ card: definition.name, data });
    }

    return events;
  };

  return { collect, has: (name: string) => byName.has(name), tools };
};
