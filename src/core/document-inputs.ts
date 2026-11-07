export * from "./documents.ts";
import { documentFallbackText, fitDocumentText, type DocumentInput, type DocumentTextBudget } from "./documents.ts";
export async function documentsFallbackText(
  documents: readonly DocumentInput[],
  signal?: AbortSignal,
  budget: DocumentTextBudget = { remaining: 100_000 },
): Promise<string> {
  const parts: string[] = [];
  for (const document of documents) {
    signal?.throwIfAborted();
    if (budget.remaining <= 0) {
      parts.push(`Document ${JSON.stringify(document.name)} omitted because the document text budget was exhausted.`);
      continue;
    }
    parts.push(fitDocumentText(await documentFallbackText(document, signal), budget));
  }
  return parts.join("\n\n");
}
