// Coverage for drip/records.ts: realizeBeat's beat→record realization for all three DrippedArtifact
// kinds (email/task/transcript), and buildInsertPayload's base64 encoding step for ContentVersion
// (review finding #2) — Salesforce stores ContentVersion.VersionData as a base64-encoded BLOB; without
// this step a transcript beat's plain-text VersionData inserts as unencoded bytes and the org stores
// garbage (loader.ts's own cascade already does this; the drip's append-only path was missing it).

import { describe, it, expect } from "vitest";
import type { GenericRecord } from "@dataseed/core";
import { realizeBeat, buildInsertPayload, stripBookkeeping, type RecordTarget, type RecordParticipant } from "../src/drip/records.js";
import type { DraftBeat } from "../src/drip/beats.js";

const target: RecordTarget = {
  oppId: "006A",
  accountName: "Acme",
  amountUsd: 500_000,
  closeDate: "2026-12-31",
  primaryContactName: "Dana Kessler",
  aeName: "Alex Rivera",
  aeEmail: "alex@sellerco.com",
};

const participant: RecordParticipant = { contactId: "003A1", name: "Dana Kessler", email: "dana@acme-prospect.com", persona: "Champion" };

const emailBeat: DraftBeat = { kind: "email", day: "2026-09-04T15:00:00.000Z", author: "Dana Kessler", authorRef: "003A1", participantRef: "003A1", direction: "inbound", sentiment: "Risk", summary: "budget pushback", conveys: "the CFO wants a revised quote" };
const taskBeat: DraftBeat = { kind: "task", day: "2026-09-04T00:00:00.000Z", author: "Alex Rivera", participantRef: "003A1", sentiment: "Neutral", summary: "logged a call recap" };
const transcriptBeat: DraftBeat = { kind: "transcript", day: "2026-09-04T00:00:00.000Z", author: "Alex Rivera", participantRef: "003A1", sentiment: "Positive", summary: "discovery call" };

describe("realizeBeat — email", () => {
  it("an inbound email sets Incoming=true, Status='0', and swaps From/To around the participant", () => {
    const artifact = realizeBeat("email-1", emailBeat, { ...target, participant }, { scenario: "at-risk-budget", day: "2026-09-04" });
    expect(artifact.object).toBe("EmailMessage");
    const r = artifact.record;
    expect(r.Incoming).toBe(true);
    expect(r.Status).toBe("0");
    expect(r.FromAddress).toBe(participant.email);
    expect(r.ToAddress).toBe(target.aeEmail);
    expect(r.RelatedToId).toBe(target.oppId);
    expect(r._ref).toBe("email-1");
  });

  it("an outbound email (no participant) sends FROM the AE and defaults ToAddress to the AE too (no counterpart resolved)", () => {
    const outbound: DraftBeat = { ...emailBeat, direction: "outbound", author: "Alex Rivera" };
    const artifact = realizeBeat("email-2", outbound, target, { scenario: "at-risk-budget", day: "2026-09-04" });
    const r = artifact.record;
    expect(r.Incoming).toBe(false);
    expect(r.Status).toBe("3");
    expect(r.FromAddress).toBe(target.aeEmail);
    expect(r.ToAddress).toBe(target.aeEmail); // no participant → falls back to the AE's own address
  });

  it("carries the beat's sentiment into the CopyRequest facts/beat, and threads a drip-scoped threadId", () => {
    const artifact = realizeBeat("email-3", emailBeat, { ...target, participant }, { scenario: "at-risk-budget", day: "2026-09-04" });
    expect(artifact.copyRequest.beat?.sentiment).toBe("Risk");
    expect(artifact.copyRequest.threadId).toBe("drip-2026-09-04-email-3");
    expect(artifact.copyRequest.facts?.counterpart).toBe("Dana Kessler");
  });
});

describe("realizeBeat — task", () => {
  it("sets WhoId from the resolved participant, ActivityDate truncated to a date, and TaskSubtype='Email' (REQUIRED for downstream email-activity triggers to fan out)", () => {
    const artifact = realizeBeat("task-1", taskBeat, { ...target, participant }, { scenario: "healthy-tech", day: "2026-09-04" });
    expect(artifact.object).toBe("Task");
    const r = artifact.record;
    expect(r.WhoId).toBe(participant.contactId);
    expect(r.ActivityDate).toBe("2026-09-04");
    expect(r.TaskSubtype).toBe("Email");
    expect(r.WhatId).toBe(target.oppId);
  });

  it("omits WhoId entirely when the beat has no resolved participant (internal/AE-only task)", () => {
    const artifact = realizeBeat("task-2", taskBeat, target, { scenario: "healthy-tech", day: "2026-09-04" });
    expect("WhoId" in artifact.record).toBe(false);
  });

  it("maps a Risk/Negative sentiment to High priority, everything else to Normal", () => {
    const risky = realizeBeat("task-3", { ...taskBeat, sentiment: "Risk" }, target, { scenario: "x", day: "2026-09-04" });
    const neutral = realizeBeat("task-4", { ...taskBeat, sentiment: "Neutral" }, target, { scenario: "x", day: "2026-09-04" });
    expect(risky.record.Priority).toBe("High");
    expect(neutral.record.Priority).toBe("Normal");
  });
});

describe("realizeBeat — transcript (ContentVersion)", () => {
  it("sets FirstPublishLocationId to the Opportunity (auto-creates the ContentDocumentLink) and starts VersionData empty", () => {
    const artifact = realizeBeat("cv-1", transcriptBeat, { ...target, participant }, { scenario: "healthy-tech", day: "2026-09-04" });
    expect(artifact.object).toBe("ContentVersion");
    const r = artifact.record;
    expect(r.FirstPublishLocationId).toBe(target.oppId);
    expect(r.VersionData).toBe("");
    expect(typeof r.Title).toBe("string");
    expect(r.PathOnClient).toMatch(/\.vtt$/);
  });
});

describe("stripBookkeeping", () => {
  it("drops every underscore-prefixed key, keeps everything else", () => {
    const record: GenericRecord = { _ref: "x", _meta: { drip: true }, Subject: "hi", Amount: 5 };
    expect(stripBookkeeping(record)).toEqual({ Subject: "hi", Amount: 5 });
  });
});

describe("buildInsertPayload — ContentVersion base64 encoding (review finding #2)", () => {
  const createable = new Set(["FirstPublishLocationId", "Title", "PathOnClient", "VersionData", "Description"]);

  it("base64-encodes VersionData for a ContentVersion so it round-trips back to the original text", () => {
    const originalText = "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nDana: The budget got pushed to next quarter.\n";
    const record: GenericRecord = { _ref: "cv-1", FirstPublishLocationId: "006A", Title: "transcript", PathOnClient: "eci.vtt", VersionData: originalText, Description: "d" };

    const payload = buildInsertPayload("ContentVersion", record, createable);

    expect(payload.VersionData).not.toBe(originalText); // it WAS transformed
    const decoded = Buffer.from(payload.VersionData as string, "base64").toString("utf8");
    expect(decoded).toBe(originalText); // …and round-trips back exactly
  });

  it("is a no-op for an empty VersionData string (nothing to encode)", () => {
    const record: GenericRecord = { _ref: "cv-2", FirstPublishLocationId: "006A", Title: "t", PathOnClient: "eci.vtt", VersionData: "" };
    const payload = buildInsertPayload("ContentVersion", record, createable);
    expect(payload.VersionData).toBe("");
  });

  it("never encodes VersionData-shaped fields for a non-ContentVersion object (EmailMessage/Task untouched)", () => {
    const record: GenericRecord = { _ref: "t-1", VersionData: "should not be touched on a Task", Subject: "s" };
    const payload = buildInsertPayload("Task", record, new Set(["VersionData", "Subject"]));
    expect(payload.VersionData).toBe("should not be touched on a Task");
  });

  it("strips bookkeeping keys AND filters to only createable fields, together with the base64 step", () => {
    const record: GenericRecord = { _ref: "cv-3", _meta: { drip: true }, FirstPublishLocationId: "006A", Title: "t", PathOnClient: "eci.vtt", VersionData: "hello", NotCreateable__c: "x" };
    const payload = buildInsertPayload("ContentVersion", record, createable);
    expect(payload).not.toHaveProperty("_ref");
    expect(payload).not.toHaveProperty("_meta");
    expect(payload).not.toHaveProperty("NotCreateable__c");
    expect(Buffer.from(payload.VersionData as string, "base64").toString("utf8")).toBe("hello");
  });
});
