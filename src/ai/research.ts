import {
  boundedQueries,
  evidenceText,
  sourceSupportsQuote,
  type SearchProvider,
  type SearchResult,
  type SearchSource,
} from "@absolutejs/search";
export type ResearchFinding = {
  claim: string;
  sourceId: string;
  quote: string;
  eventDate?: string;
};
export type ResearchEvidence = {
  status: "grounded" | "partial" | "empty" | "unavailable";
  text: string;
  findings: ResearchFinding[];
  sources: SearchSource[];
  searches: SearchResult[];
  limitations: string[];
  generatedAt: string;
};
export type ResearchSynthesis = {
  findings: ResearchFinding[];
  limitations?: string[];
};
/** Retrieval and synthesis are separate injected capabilities. No hosted search is enabled here. */
export const researchWithEvidence = async (input: {
  query: string;
  queries?: string[];
  provider: SearchProvider;
  signal?: AbortSignal;
  maxQueries?: number;
  maxTokens?: number;
  freshness?: string;
  /** Required literal entity phrases; defaults to quoted phrases in the question. */
  requiredPhrases?: string[];
  synthesize: (
    evidence: string,
    signal?: AbortSignal,
  ) => Promise<ResearchSynthesis>;
}): Promise<ResearchEvidence> => {
  const requested = input.queries ?? boundedQueries(input.query);
  const maxQueries = input.maxQueries ?? 2;
  if (!Number.isInteger(maxQueries) || maxQueries < 1)
    throw new Error("Research requires a positive query budget");
  const searches: SearchResult[] = [];
  const limitations: string[] = [];
  const generatedAt = new Date().toISOString();
  if (requested.length > maxQueries)
    limitations.push(
      "Query budget reached; some requested research was not performed",
    );
  for (const query of requested.slice(0, maxQueries)) {
    input.signal?.throwIfAborted();
    searches.push(
      await input.provider.search({
        query,
        mode: "context",
        signal: input.signal,
        maxTokens: input.maxTokens ?? 4096,
        freshness: input.freshness,
      }),
    );
  }
  input.signal?.throwIfAborted();
  const byUrl = new Map<string, SearchSource>();
  for (const search of searches) {
    limitations.push(...search.limitations);
    for (const source of search.sources) {
      const previous = byUrl.get(source.url);
      byUrl.set(
        source.url,
        previous
          ? {
              ...previous,
              excerpts: [
                ...new Set([...previous.excerpts, ...source.excerpts]),
              ],
            }
          : source,
      );
    }
  }
  const normalize = (value: string) =>
    value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  const requiredPhrases =
    input.requiredPhrases ??
    [...input.query.matchAll(/"([^"\n]+)"/gu)].map((match) => match[1]!);
  const sources = [...byUrl.values()].filter((source) =>
    requiredPhrases.every((phrase) =>
      normalize(`${source.title} ${source.excerpts.join(" ")}`).includes(
        normalize(phrase),
      ),
    ),
  );
  if (sources.length < byUrl.size)
    limitations.push(
      "Sources that did not establish the required literal entity were excluded; similarly named entities are not substitutes.",
    );
  const complete =
    searches.length > 0 &&
    searches.every(
      (search) => search.status === "ok" || search.status === "empty",
    ) &&
    requested.length <= maxQueries;
  const base = { searches, sources, limitations, generatedAt };
  if (!sources.length)
    return {
      ...base,
      status: complete ? "empty" : "unavailable",
      text: "",
      findings: [],
    };
  input.signal?.throwIfAborted();
  const synthesis = await input.synthesize(evidenceText(sources), input.signal);
  const findings = synthesis.findings.filter((finding) => {
    const source = sources.find((source) => source.id === finding.sourceId);
    return (
      typeof finding.claim === "string" &&
      Boolean(finding.claim.trim()) &&
      typeof finding.quote === "string" &&
      source &&
      sourceSupportsQuote(source, finding.quote)
    );
  });
  if (findings.length !== synthesis.findings.length)
    limitations.push(
      "Unsupported source references or quotations were excluded",
    );
  limitations.push(...(synthesis.limitations ?? []));
  const text = findings
    .map(
      (finding) =>
        `${finding.claim}\nEvidence: ${finding.quote}\nSource: ${sources.find((source) => source.id === finding.sourceId)!.url}`,
    )
    .join("\n\n");
  // Quotation/source checks establish provenance, not semantic entailment. Host review remains necessary.
  return {
    ...base,
    status:
      complete && findings.length > 0 && !limitations.length
        ? "grounded"
        : "partial",
    text,
    findings,
  };
};
