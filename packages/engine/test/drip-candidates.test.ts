// Coverage for drip/candidates.ts's two org-facing helpers that need no registry (SfClient-only, so a
// plain fake SfClient is enough — no sqlite, no `sf` CLI):
//   - fetchReconstructionRows: shapes raw SOQL rows (OpportunityContactRole/EmailMessage/Task/
//     ContentVersion) into the ReconstructCastRow/ReconstructEmailRow/ReconstructTaskRow/
//     ReconstructTranscriptRow arrays dossier.ts's reconstruction needs.
//   - fetchContactIdsByName: the AMBIGUITY GUARD (review finding #1) — a Name shared by two distinct
//     Contact.Ids on the same Opportunity's buying committee must be excluded from `byName` and
//     reported in `ambiguousNames`, never resolved by picking one arbitrarily.

import { describe, it, expect } from "vitest";
import { fetchReconstructionRows, fetchContactIdsByName } from "../src/drip/candidates.js";
import type { SfClient } from "../src/introspect/sf-client.js";

/** A fake SfClient whose `query` dispatches on a recognizable substring of the SOQL — good enough for
 *  these tests, which only ever issue the fixed queries candidates.ts itself builds. */
function fakeClient(byQueryMatch: Array<[RegExp, unknown[]]>): SfClient {
  return {
    org: "mock",
    async query<T>(soql: string): Promise<T[]> {
      for (const [re, rows] of byQueryMatch) if (re.test(soql)) return rows as T[];
      return [] as T[];
    },
    async limits() {
      return [];
    },
    async describe() {
      return { fields: [] } as never;
    },
    async restGet() {
      return { status: 200, body: {} } as never;
    },
  };
}

describe("fetchReconstructionRows — org-reconstruction row mapping", () => {
  it("maps OCR/EmailMessage/Task/ContentVersion rows into the shapes dossier.ts's reconstruction expects", async () => {
    const client = fakeClient([
      [/FROM OpportunityContactRole/, [{ ContactId: "003A1", Contact: { Name: "Dana Kessler" }, Role: "Decision Maker" }]],
      [
        /FROM EmailMessage/,
        [{ Id: "02s1", RelatedToId: "006A", Subject: "Budget check-in", TextBody: "Following up on budget.", MessageDate: "2026-08-20T15:00:00.000Z", FromName: "Dana Kessler", Incoming: true }],
      ],
      [/FROM Task/, [{ Id: "00T1", WhatId: "006A", Who: { Name: "Alex Rivera" }, Subject: "Call recap", Description: "Discussed timeline.", ActivityDate: "2026-08-21" }]],
      [/FROM ContentVersion/, [{ Id: "068A", Title: "ECI transcript — Acme (2026-08-22)", CreatedDate: "2026-08-22T00:00:00.000Z" }]],
    ]);

    const rows = await fetchReconstructionRows(client, "006A");

    expect(rows.cast).toEqual([{ contactId: "003A1", name: "Dana Kessler", role: "Decision Maker" }]);
    expect(rows.emails).toEqual([
      { id: "02s1", relatedToId: "006A", subject: "Budget check-in", textBody: "Following up on budget.", messageDate: "2026-08-20T15:00:00.000Z", fromName: "Dana Kessler", incoming: true },
    ]);
    expect(rows.tasks).toEqual([{ id: "00T1", whatId: "006A", whoName: "Alex Rivera", subject: "Call recap", description: "Discussed timeline.", activityDate: "2026-08-21" }]);
    expect(rows.transcripts).toEqual([{ id: "068A", title: "ECI transcript — Acme (2026-08-22)", createdDate: "2026-08-22T00:00:00.000Z" }]);
  });

  it("drops OCR rows with no ContactId, and falls back to 'Unknown Contact' when Contact.Name is missing", async () => {
    const client = fakeClient([
      [
        /FROM OpportunityContactRole/,
        [
          { ContactId: "003A1", Contact: {}, Role: "Champion" }, // no Name
          { ContactId: null, Contact: { Name: "Ghost" }, Role: "Blocker" }, // no ContactId — dropped
        ],
      ],
    ]);
    const rows = await fetchReconstructionRows(client, "006A");
    expect(rows.cast).toEqual([{ contactId: "003A1", name: "Unknown Contact", role: "Champion" }]);
  });

  it("returns empty arrays for every stream when the org has no history for this Opportunity", async () => {
    const client = fakeClient([]);
    const rows = await fetchReconstructionRows(client, "006Z");
    expect(rows).toEqual({ cast: [], emails: [], tasks: [], transcripts: [] });
  });
});

describe("fetchContactIdsByName — the ambiguity guard (review finding #1)", () => {
  it("resolves an unambiguous name (exactly one distinct Contact.Id observed) into byName", async () => {
    const client = fakeClient([[/FROM OpportunityContactRole/, [{ ContactId: "003A1", Contact: { Name: "Dana Kessler" } }]]]);
    const { byName, ambiguousNames } = await fetchContactIdsByName(client, "006A");
    expect(byName.get("Dana Kessler")).toBe("003A1");
    expect(ambiguousNames).toEqual([]);
  });

  it("excludes a name shared by two DISTINCT Contact.Ids from byName and reports it in ambiguousNames — never picks one arbitrarily (last-write-wins regression guard)", async () => {
    const client = fakeClient([
      [
        /FROM OpportunityContactRole/,
        [
          { ContactId: "003A1", Contact: { Name: "Chris Lee" } },
          { ContactId: "003A2", Contact: { Name: "Chris Lee" } }, // same Name, DIFFERENT Contact — ambiguous
          { ContactId: "003A3", Contact: { Name: "Dana Kessler" } }, // unambiguous, unaffected
        ],
      ],
    ]);
    const { byName, ambiguousNames } = await fetchContactIdsByName(client, "006A");
    expect(byName.has("Chris Lee")).toBe(false); // not present at all — not "003A1", not "003A2"
    expect(ambiguousNames).toEqual(["Chris Lee"]);
    expect(byName.get("Dana Kessler")).toBe("003A3"); // the unambiguous name still resolves normally
  });

  it("the SAME Contact.Id appearing twice for one name (duplicate OCR rows) is NOT ambiguous", async () => {
    const client = fakeClient([
      [
        /FROM OpportunityContactRole/,
        [
          { ContactId: "003A1", Contact: { Name: "Dana Kessler" } },
          { ContactId: "003A1", Contact: { Name: "Dana Kessler" } }, // duplicate row, same Id
        ],
      ],
    ]);
    const { byName, ambiguousNames } = await fetchContactIdsByName(client, "006A");
    expect(byName.get("Dana Kessler")).toBe("003A1");
    expect(ambiguousNames).toEqual([]);
  });

  it("skips rows with no ContactId or no Contact.Name entirely", async () => {
    const client = fakeClient([
      [
        /FROM OpportunityContactRole/,
        [
          { ContactId: "003A1", Contact: {} },
          { ContactId: null, Contact: { Name: "Ghost" } },
        ],
      ],
    ]);
    const { byName, ambiguousNames } = await fetchContactIdsByName(client, "006A");
    expect(byName.size).toBe(0);
    expect(ambiguousNames).toEqual([]);
  });
});
