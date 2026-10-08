// The prerequisite checks behind `node bin/setup.js` — each one against a fake machine.

import { describe, it, expect } from "vitest";
import {
  checkNode,
  checkPnpm,
  checkDeps,
  checkSf,
  checkOrg,
  checkCopy,
  depsState,
  parseOrgList,
  pinnedPnpmVersion,
  readApiKey,
  runChecks,
} from "../../../bin/lib/prereqs.js";
import { machine, INSTALLED, READY_BINS, ROOT, at, orgListJson } from "./fake-machine.js";

describe("checkNode", () => {
  it("requires Node 22+", () => {
    expect(checkNode(machine({ node: "20.11.1" }).sys)).toMatchObject({ status: "missing", required: true });
    expect(checkNode(machine({ node: "22.0.0" }).sys)).toMatchObject({ status: "ok", detail: "v22.0.0" });
    expect(checkNode(machine({ node: "26.7.0" }).sys).status).toBe("ok");
  });
});

describe("checkPnpm", () => {
  it("reports the installed version", () => {
    expect(checkPnpm(machine({ bins: { pnpm: () => ({ stdout: "11.7.0\n" }) } }).sys)).toMatchObject({ status: "ok", detail: "11.7.0" });
  });

  it("when missing, notes whether corepack can provide it (Node 25+ dropped corepack)", () => {
    expect(checkPnpm(machine().sys)).toMatchObject({ status: "missing", corepack: false });
    expect(checkPnpm(machine({ bins: { corepack: () => ({ stdout: "0.31.0" }) } }).sys)).toMatchObject({ status: "missing", corepack: true });
  });

  it("reads the pinned pnpm version from package.json", () => {
    expect(pinnedPnpmVersion(machine().sys)).toBe("11.7.0");
    expect(pinnedPnpmVersion(machine({ files: { "package.json": "{}" } }).sys)).toBe("latest");
  });
});

describe("depsState / checkDeps", () => {
  it("missing until node_modules has the markers the entrypoints need", () => {
    const m = machine();
    expect(depsState(ROOT, m.sys)).toBe("missing");
    expect(checkDeps(m.sys)).toMatchObject({ status: "missing", required: true });
  });

  it("ok when the installed lockfile matches pnpm-lock.yaml", () => {
    expect(depsState(ROOT, machine({ files: INSTALLED }).sys)).toBe("ok");
  });

  it("stale when pnpm-lock.yaml changed since the install (e.g. after git pull)", () => {
    const m = machine({ files: { ...INSTALLED, "pnpm-lock.yaml": "lock-v2" } });
    expect(depsState(ROOT, m.sys)).toBe("stale");
    expect(checkDeps(m.sys)).toMatchObject({ status: "warn" });
  });
});

describe("checkSf", () => {
  it("extracts the CLI version from `sf --version`", () => {
    expect(checkSf(machine({ bins: READY_BINS }).sys)).toMatchObject({ status: "ok", detail: "2.152.14", required: false });
  });

  it("is optional — offline generation works without it", () => {
    expect(checkSf(machine().sys)).toMatchObject({ status: "missing", required: false });
  });
});

describe("parseOrgList", () => {
  const json = orgListJson([
    { alias: "demo-org", username: "a@x.example", connectedStatus: "Connected", isDefaultUsername: true },
    { alias: "old-sandbox", username: "b@x.example", connectedStatus: "Unable to refresh session due to: expired" },
    { alias: "scratch-1", username: "c@x.example", isScratch: true, status: "Active" },
    { alias: "scratch-old", username: "d@x.example", isScratch: true, status: "Expired" },
  ]);

  it("dedupes orgs sf repeats across categories, and knows which are usable", () => {
    const orgs = parseOrgList(json);
    expect(orgs).toHaveLength(4);
    expect(orgs.filter((o) => o.connected).map((o) => o.alias).sort()).toEqual(["demo-org", "scratch-1"]);
    expect(orgs.find((o) => o.alias === "demo-org")?.isDefault).toBe(true);
  });

  it("never copies tokens or URLs out of the envelope", () => {
    const out = JSON.stringify(parseOrgList(json));
    expect(out).not.toContain("SECRET-TOKEN");
    expect(out).not.toContain("salesforce.com");
  });

  it("returns [] for anything unparseable", () => {
    expect(parseOrgList("")).toEqual([]);
    expect(parseOrgList("Warning: update available\n{")).toEqual([]);
    expect(parseOrgList('{"status":1}')).toEqual([]);
  });
});

describe("checkOrg", () => {
  const withOrgs = (orgs: Array<Record<string, unknown>>) =>
    machine({ bins: { sf: () => ({ stdout: orgListJson(orgs) }) } }).sys;

  it("waits on the Salesforce CLI", () => {
    expect(checkOrg(machine().sys, false)).toMatchObject({ status: "missing", detail: "needs the Salesforce CLI first" });
  });

  it("ok with a connected alias, listing up to three", () => {
    const orgs = ["a", "b", "c", "d"].map((x) => ({ alias: x, username: `${x}@x.example`, connectedStatus: "Connected" }));
    expect(checkOrg(withOrgs(orgs), true)).toMatchObject({ status: "ok", detail: "logged in: a, b, c (+1 more)" });
  });

  it("warns when orgs are on file but none is connected", () => {
    expect(checkOrg(withOrgs([{ alias: "x", username: "x@x.example", connectedStatus: "expired" }]), true).status).toBe("warn");
  });

  it("missing when nothing is logged in", () => {
    expect(checkOrg(withOrgs([]), true)).toMatchObject({ status: "missing", detail: "none logged in yet" });
  });
});

describe("readApiKey / checkCopy", () => {
  it("reads the key from the environment first, then .env (quotes, export, comments)", () => {
    expect(readApiKey(machine({ env: { ANTHROPIC_API_KEY: "sk-ant-env" } }).sys).key).toBe("sk-ant-env");
    expect(readApiKey(machine({ files: { ".env": 'export ANTHROPIC_API_KEY="sk-ant-file"\n' } }).sys)).toEqual({ envFile: true, key: "sk-ant-file" });
    expect(readApiKey(machine({ files: { ".env": "# ANTHROPIC_API_KEY=sk-ant-commented\n" } }).sys)).toEqual({ envFile: true, key: null });
    expect(readApiKey(machine().sys)).toEqual({ envFile: false, key: null });
  });

  it("ok with the claude CLI, an API key, or both", () => {
    expect(checkCopy(machine({ bins: READY_BINS }).sys)).toMatchObject({ status: "ok", detail: "claude CLI 2.1.287 (your Claude subscription)" });
    expect(checkCopy(machine({ env: { ANTHROPIC_API_KEY: "sk-ant-real" } }).sys)).toMatchObject({ status: "ok", detail: "ANTHROPIC_API_KEY set" });
  });

  it("flags the template placeholder — the API provider would fail on every call", () => {
    const c = checkCopy(machine({ bins: READY_BINS, files: { ".env": "ANTHROPIC_API_KEY=sk-ant-...\n" } }).sys);
    expect(c).toMatchObject({ status: "warn", placeholderKey: true });
  });

  it("warns (doesn't fail) with neither — the static template tier still works", () => {
    expect(checkCopy(machine().sys)).toMatchObject({ status: "warn", required: false });
  });
});

describe("runChecks", () => {
  it("runs every check in dependency order", () => {
    const checks = runChecks(machine({ bins: READY_BINS, files: INSTALLED }).sys);
    expect(checks.map((c) => c.id)).toEqual(["node", "pnpm", "deps", "sf", "org", "copy"]);
    expect(checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("doesn't ask sf for orgs when sf isn't there", () => {
    const m = machine({ files: INSTALLED });
    expect(runChecks(m.sys).find((c) => c.id === "org")?.detail).toBe("needs the Salesforce CLI first");
    expect(at(".env")).toBe("/repo/.env");
  });
});
