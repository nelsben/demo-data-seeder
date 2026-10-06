// packages/engine/src/identity/guard.ts
//
// Validation + the self-product guard for an authored AccountIdentity. The realism campaign's
// "MongoDB-class" tell: a synthetic prospect whose OWN product category IS the seller's (a BI / data /
// analytics / integration vendor) reads as "selling them what they make." The prompt forbids it; this is
// the deterministic safety net — a draft that trips the banned-category regex is DROPPED (→ the
// orchestrator falls back to the next provider / static), exactly like the spine layer drops an
// unparseable draft. So a bad identity never reaches the records.

import { AccountIdentity } from "@dataseed/core";

/** The seller's own category — a prospect must NOT be one of these (it would be selling them their own product). */
export const SELF_PRODUCT_RE =
  /\b(business intelligence|BI (?:tool|platform|vendor|software)|analytics (?:platform|vendor|software)|data warehous\w*|data lake\w*|lakehouse|data platform|integration platform|iPaaS|reverse ETL|\bETL\b|observability|dashboard\w*|embedded analytics|customer data platform|\bCDP\b|data pipeline\w*)\b/i;

/** True if the company's own product space collides with the seller's (a self-product identity). */
export function isLikelySelfProduct(id: Pick<AccountIdentity, "does" | "products" | "description">): boolean {
  const hay = [id.does, id.description, ...(id.products ?? [])].filter(Boolean).join(" • ");
  return SELF_PRODUCT_RE.test(hay);
}

/** Validate an arbitrary value as an AccountIdentity (Zod) and reject self-product drafts. Null = drop. */
export function validateIdentity(raw: unknown): AccountIdentity | null {
  const parsed = AccountIdentity.safeParse(raw);
  if (!parsed.success) return null;
  if (isLikelySelfProduct(parsed.data)) return null;
  return parsed.data;
}

/** Extract the JSON object from a CLI response (tolerant of stray prose / code fences), then validate. */
export function parseIdentity(text: string): AccountIdentity | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return validateIdentity(JSON.parse(t.slice(start, end + 1)));
  } catch {
    return null;
  }
}
