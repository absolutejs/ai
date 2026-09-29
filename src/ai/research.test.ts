import { test, expect } from "bun:test";
import { researchWithEvidence } from "./research";
import type { SearchProvider } from "@absolutejs/search";
const provider: SearchProvider = {
  name: "test",
  version: "1",
  search: async ({ query }) => ({
    provider: "test",
    version: "1",
    query,
    status: "ok",
    sources: [
      {
        id: "s1",
        url: "https://acme.com/news",
        title: "News",
        retrievedAt: "2026-09-24",
        excerpts: ["Acme launched a partner program in September."],
      },
    ],
    attempts: [],
    limitations: [],
  }),
};
test("retains only quotations bound to retrieved evidence", async () => {
  const result = await researchWithEvidence({
    query: "Acme",
    provider,
    synthesize: async () => ({
      findings: [
        {
          claim: "Partner program launched",
          sourceId: "s1",
          quote: "Acme launched a partner program in September.",
        },
        {
          claim: "Raised funding",
          sourceId: "invented",
          quote: "Acme raised money.",
        },
      ],
    }),
  });
  expect(result.findings).toHaveLength(1);
  expect(result.status).toBe("partial");
  expect(result.text).toContain("https://acme.com/news");
});
test("empty search does not invoke synthesis", async () => {
  const result = await researchWithEvidence({
    query: "Acme",
    provider: {
      ...provider,
      search: async ({ query }) => ({
        provider: "test",
        version: "1",
        query,
        status: "empty",
        sources: [],
        attempts: [],
        limitations: [],
      }),
    },
    synthesize: async () => {
      throw Error("must not run");
    },
  });
  expect(result.status).toBe("empty");
});

test("quoted entity constraints reject near matches without synthesizing substitute companies", async () => {
  const result = await researchWithEvidence({
    query: '"Acme Nonexistent 9183" partnerships',
    provider,
    synthesize: async () => {
      throw Error("must not synthesize wrong entity");
    },
  });
  expect(result.status).toBe("empty");
  expect(result.sources).toHaveLength(0);
  expect(result.findings).toHaveLength(0);
  expect(result.searches[0]?.sources).toHaveLength(1);
});
