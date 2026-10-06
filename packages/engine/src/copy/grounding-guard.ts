// packages/engine/src/copy/grounding-guard.ts
//
// The grounding guard (Phase 4D) — a DETERMINISTIC, zero-LLM check (the built version of the realism
// backlog's "don't sell a company its own product") that runs over the FILLED copy + the deal dossiers.
// Where voice-lint catches HOW copy reads, the grounding guard catches whether it's grounded in the
// deal's facts:
//   • SELF_AS_COMPETITOR — an artifact frames the PROSPECT's own company as a competitor/alternative.
//   • FOREIGN_DEAL_FIGURE — a deal-magnitude dollar figure that contradicts the loaded record's amount.
// Cheap, repeatable, and it never asks the model anything — so it can gate a run for free.

import type { NarrativeBundle, DealDossier } from "@dataseed/core";
import type { Severity } from "./voice-lint.js";

export interface GroundingViolation {
  id: string; // the record _ref
  rule: "SELF_AS_COMPETITOR" | "FOREIGN_DEAL_FIGURE";
  severity: Severity;
  detail: string;
}
export interface GroundingReport {
  checked: number;
  clean: number;
  violations: GroundingViolation[];
  byRule: Record<string, number>;
}

/** The body field per content kind. */
const BODY_FIELD: Record<string, string> = { EmailMessage: "TextBody", Task: "Description", ContentVersion: "VersionData" };
/** The parent-Opportunity ref field per content kind. */
const OPP_REF: Record<string, string> = { EmailMessage: "RelatedToId", Task: "WhatId", ContentVersion: "FirstPublishLocationId" };

/** The prospect's core brand token (first word of the account name, sans "Inc"/"(Div 2)" noise). */
function coreName(accountName: string): string {
  return (accountName.split(/[—,(]/)[0] ?? accountName).trim().split(/\s+/)[0] ?? accountName;
}

/** Parse a $-figure to USD; returns null if it isn't a magnitude figure. */
function parseUsd(num: string, unit: string | undefined): number | null {
  const n = parseFloat(num.replace(/,/g, ""));
  if (!isFinite(n)) return null;
  const u = (unit ?? "").toLowerCase();
  if (u === "m" || u === "million") return n * 1_000_000;
  if (u === "k" || u === "thousand") return n * 1_000;
  return n;
}

const COMPETE = /(?:\bvs\.?\b|\bversus\b|\bcompetitors?\b|\balternative to\b|\bcompared to\b|\binstead of\b|\bswitch from\b|\bbeat\b|\brip(?:ping)? out\b)/gi;
const FIGURE = /\$\s?([\d][\d,]*(?:\.\d+)?)\s?(million|thousand|m|k)?\b/gi;

/** True if the prospect's own name appears within ~40 chars AFTER a competitor-framing phrase. */
function framesSelfAsCompetitor(body: string, prospect: string): string | null {
  const name = coreName(prospect);
  if (name.length < 3) return null;
  const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  for (const m of body.matchAll(COMPETE)) {
    const window = body.slice(m.index!, m.index! + m[0].length + 40);
    if (nameRe.test(window.slice(m[0].length))) return `frames "${name}" as a competitor/alternative ("…${window.replace(/\s+/g, " ").trim().slice(0, 60)}…")`;
  }
  return null;
}

/** A deal-magnitude (≥ $100K) figure in the body that matches neither the amount nor the ceiling. */
function foreignDealFigure(body: string, amount: number, ceiling?: number): string | null {
  const ok = (v: number) => Math.abs(v - amount) <= amount * 0.05 || (ceiling != null && Math.abs(v - ceiling) <= ceiling * 0.05);
  for (const m of body.matchAll(FIGURE)) {
    const v = parseUsd(m[1]!, m[2]);
    if (v == null || v < 100_000) continue; // sub-$100K figures (caps, savings, line items) are too varied to validate
    if (!ok(v)) return `quotes ${m[0].trim()} (~$${Math.round(v).toLocaleString("en-US")}), but the deal is $${amount.toLocaleString("en-US")}${ceiling ? ` (ceiling $${ceiling.toLocaleString("en-US")})` : ""}`;
  }
  return null;
}

/** Run the grounding guard over a filled bundle. Pure; safe to run every fill. */
export function groundingGuard(bundle: NarrativeBundle): GroundingReport {
  // Index the deal facts by Opportunity ref.
  const acctNameByRef = new Map((bundle.records.Account ?? []).map((a) => [a._ref as string, a.Name as string]));
  const dealByOpp = new Map<string, { dossier: DealDossier; prospect: string }>();
  for (const o of bundle.records.Opportunity ?? []) {
    const dossier = (o._meta as { dossier?: DealDossier } | undefined)?.dossier;
    if (!dossier || typeof o._ref !== "string") continue;
    const acctRef = (o._refs as Record<string, string> | undefined)?.AccountId;
    const prospect = (acctRef ? acctNameByRef.get(acctRef) : undefined) ?? (o.Name as string) ?? "";
    dealByOpp.set(o._ref, { dossier, prospect });
  }

  const violations: GroundingViolation[] = [];
  let checked = 0;
  for (const [object, bodyField] of Object.entries(BODY_FIELD)) {
    for (const rec of bundle.records[object] ?? []) {
      const body = rec[bodyField];
      if (typeof body !== "string" || !body.trim()) continue;
      const oppRef = (rec._refs as Record<string, string> | undefined)?.[OPP_REF[object]!];
      const deal = oppRef ? dealByOpp.get(oppRef) : undefined;
      if (!deal) continue;
      checked++;
      const id = (rec._ref as string) ?? "?";
      const self = framesSelfAsCompetitor(body, deal.prospect);
      if (self) violations.push({ id, rule: "SELF_AS_COMPETITOR", severity: "high", detail: self });
      const fig = foreignDealFigure(body, deal.dossier.numbers.amountUsd, deal.dossier.numbers.ceilingUsd);
      if (fig) violations.push({ id, rule: "FOREIGN_DEAL_FIGURE", severity: "medium", detail: fig });
    }
  }

  const byRule: Record<string, number> = {};
  for (const v of violations) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
  const dirty = new Set(violations.map((v) => v.id));
  return { checked, clean: checked - dirty.size, violations, byRule };
}
