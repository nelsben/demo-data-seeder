// The setup wizard's flow: what it asks, what it runs, and what it leaves alone — on a fake machine,
// so no test ever installs anything globally.

import { describe, it, expect } from "vitest";
import { runWizard } from "../../../bin/lib/wizard.js";
import { machine, install, INSTALLED, READY_BINS, at, orgListJson, scriptedIO } from "./fake-machine.js";

const sfWithOrgs = (orgs: Array<Record<string, unknown>>) => (args: string[]) =>
  args[0] === "--version" ? { stdout: "@salesforce/cli/2.152.14 darwin-arm64\n" } : { stdout: orgListJson(orgs) };

describe("runWizard — nothing to do", () => {
  it("prints the report and next steps for the logged-in org, asks nothing, runs nothing", async () => {
    const m = machine({ bins: READY_BINS, files: INSTALLED });
    const t = scriptedIO();
    const r = await runWizard({ sys: m.sys, io: t.io, mode: "interactive" });
    expect(r.ok).toBe(true);
    expect(t.prompts).toEqual([]);
    expect(m.runs).toEqual([]);
    expect(t.output()).toContain("Everything's ready.");
    expect(t.output()).toContain("node bin/run-op.js run profile-org --org demo-org --pack salescloud");
  });

  it("with no org, points at the offline path instead", async () => {
    const m = machine({ bins: { ...READY_BINS, sf: sfWithOrgs([]) }, files: INSTALLED });
    const t = scriptedIO(["3"]); // "Not now" at the org step
    await runWizard({ sys: m.sys, io: t.io, mode: "interactive" });
    expect(t.output()).toContain("--org standard --synthetic --pack salescloud");
  });
});

describe("runWizard --check", () => {
  it("reports and exits non-ok without a single prompt or install", async () => {
    const m = machine();
    const t = scriptedIO();
    const r = await runWizard({ sys: m.sys, io: t.io, mode: "check" });
    expect(r.ok).toBe(false);
    expect(t.prompts).toEqual([]);
    expect(m.runs).toEqual([]);
    expect(t.output()).toContain("2 required items missing.");
    expect(t.output()).toContain("✗ Packages");
  });

  it("is ok when only optional pieces are missing", async () => {
    const r = await runWizard({ sys: machine({ bins: { pnpm: READY_BINS.pnpm! }, files: INSTALLED }).sys, io: scriptedIO().io, mode: "check" });
    expect(r.ok).toBe(true);
  });

  it("explains how to fix interactively when it fell back to --check for lack of a terminal", async () => {
    const t = scriptedIO();
    await runWizard({ sys: machine().sys, io: t.io, mode: "check", nonInteractive: true });
    expect(t.output()).toContain("node bin/setup.js --yes");
  });
});

describe("runWizard — Node too old", () => {
  it("stops before touching anything and says how to upgrade", async () => {
    const m = machine({ node: "20.11.1" });
    const t = scriptedIO();
    const r = await runWizard({ sys: m.sys, io: t.io, mode: "yes" });
    expect(r.ok).toBe(false);
    expect(m.runs).toEqual([]);
    expect(t.output()).toContain("Install Node 22 or newer");
  });
});

describe("runWizard — packages", () => {
  it("asks, runs pnpm install, and ends ok", async () => {
    const m = machine({ bins: READY_BINS, onRun: (cmd, _a, mm) => (cmd === "pnpm" ? (install(mm), true) : true) });
    const t = scriptedIO(["y"]);
    const r = await runWizard({ sys: m.sys, io: t.io, mode: "interactive" });
    expect(m.runs).toEqual(["pnpm install"]);
    expect(r.ok).toBe(true);
    expect(t.output()).toContain("✓ packages installed");
  });

  it("a blank answer takes the default (yes)", async () => {
    const m = machine({ bins: READY_BINS, onRun: (_c, _a, mm) => (install(mm), true) });
    await runWizard({ sys: m.sys, io: scriptedIO([""]).io, mode: "interactive" });
    expect(m.runs).toEqual(["pnpm install"]);
  });

  it("declining installs nothing and says what that means", async () => {
    const m = machine({ bins: READY_BINS });
    const t = scriptedIO(["n"]);
    const r = await runWizard({ sys: m.sys, io: t.io, mode: "interactive" });
    expect(m.runs).toEqual([]);
    expect(r.ok).toBe(false);
    expect(t.output()).toContain("nothing in the repo will run until you do: pnpm install");
  });

  it("a failed install doesn't throw — it says how to retry", async () => {
    const m = machine({ bins: READY_BINS, onRun: () => false });
    const t = scriptedIO(["y"]);
    const r = await runWizard({ sys: m.sys, io: t.io, mode: "interactive" });
    expect(r.ok).toBe(false);
    expect(t.output()).toContain("The install didn't finish");
  });

  it("re-prompts on a nonsense answer", async () => {
    const m = machine({ bins: READY_BINS, onRun: (_c, _a, mm) => (install(mm), true) });
    const t = scriptedIO(["maybe", "y"]);
    await runWizard({ sys: m.sys, io: t.io, mode: "interactive" });
    expect(t.output()).toContain("Please answer y or n.");
    expect(m.runs).toEqual(["pnpm install"]);
  });
});

describe("runWizard — pnpm", () => {
  const noPnpm = { sf: READY_BINS.sf!, claude: READY_BINS.claude!, npm: () => ({}), npx: () => ({}) };

  it("Node 25+ (no corepack): installs the pinned pnpm with npm, then uses it", async () => {
    const m = machine({
      bins: noPnpm,
      onRun: (cmd, args, mm) => {
        if (cmd === "npm") mm.bins.pnpm = READY_BINS.pnpm!;
        if (cmd === "pnpm" && args[0] === "install") install(mm);
        return true;
      },
    });
    const r = await runWizard({ sys: m.sys, io: scriptedIO(["y", "y"]).io, mode: "interactive" });
    expect(m.runs).toEqual(["npm install --global pnpm@11.7.0", "pnpm install"]);
    expect(r.ok).toBe(true);
  });

  it("uses corepack when it exists", async () => {
    const m = machine({ bins: { ...noPnpm, corepack: () => ({}) }, onRun: (cmd, _a, mm) => (cmd === "corepack" && (mm.bins.pnpm = READY_BINS.pnpm!), true) });
    await runWizard({ sys: m.sys, io: scriptedIO(["y", "n"]).io, mode: "interactive" });
    expect(m.runs[0]).toBe("corepack enable pnpm");
  });

  it("a failed global install (e.g. EACCES) falls back to a one-off npx pnpm for the package install", async () => {
    const m = machine({ bins: noPnpm, onRun: (cmd, _a, mm) => (cmd === "npx" ? (install(mm), true) : false) });
    const t = scriptedIO(["y", "y"]);
    const r = await runWizard({ sys: m.sys, io: t.io, mode: "interactive" });
    expect(m.runs).toEqual(["npm install --global pnpm@11.7.0", "npx --yes pnpm@11.7.0 install"]);
    expect(t.output()).toContain("you may need sudo");
    expect(r.ok).toBe(true); // packages installed even though pnpm itself still isn't global
  });
});

describe("runWizard — Salesforce CLI + org login", () => {
  it("installs the CLI, then logs in to a sandbox under the alias you choose", async () => {
    const m = machine({
      bins: { pnpm: READY_BINS.pnpm!, claude: READY_BINS.claude!, npm: () => ({}) },
      files: INSTALLED,
      onRun: (cmd, args, mm) => {
        if (cmd === "npm") mm.bins.sf = sfWithOrgs([]);
        if (cmd === "sf" && args[1] === "login") mm.bins.sf = sfWithOrgs([{ alias: "my-sandbox", username: "s@x.example", connectedStatus: "Connected" }]);
        return true;
      },
    });
    const t = scriptedIO(["y", "2", "not ok!", "my-sandbox"]);
    const r = await runWizard({ sys: m.sys, io: t.io, mode: "interactive" });
    expect(m.runs).toEqual([
      "npm install --global @salesforce/cli",
      "sf org login web --alias my-sandbox --set-default --instance-url https://test.salesforce.com",
    ]);
    expect(t.output()).toContain("Letters, numbers, dots, dashes and underscores only.");
    expect(t.output()).toContain("--org my-sandbox");
    expect(r.ok).toBe(true);
    expect(t.remaining()).toBe(0);
  });

  it("a production login defaults the alias to demo-org and adds no instance URL", async () => {
    const m = machine({ bins: { ...READY_BINS, sf: sfWithOrgs([]) }, files: INSTALLED });
    await runWizard({ sys: m.sys, io: scriptedIO(["1", ""]).io, mode: "interactive" });
    expect(m.runs).toEqual(["sf org login web --alias demo-org --set-default"]);
  });

  it("skipping the CLI skips the org step too, with a pointer", async () => {
    const m = machine({ bins: { pnpm: READY_BINS.pnpm!, claude: READY_BINS.claude!, npm: () => ({}) }, files: INSTALLED });
    const t = scriptedIO(["n"]);
    await runWizard({ sys: m.sys, io: t.io, mode: "interactive" });
    expect(m.runs).toEqual([]);
    expect(t.output()).toContain("Needs the Salesforce CLI — skipping.");
  });
});

describe("runWizard --yes", () => {
  it("installs everything it can without a single prompt, but leaves the browser login to you", async () => {
    const m = machine({
      bins: { pnpm: READY_BINS.pnpm!, npm: () => ({}) },
      onRun: (cmd, args, mm) => {
        if (cmd === "pnpm") install(mm);
        if (cmd === "npm" && args.includes("@salesforce/cli")) mm.bins.sf = sfWithOrgs([]);
        if (cmd === "npm" && args.includes("@anthropic-ai/claude-code")) mm.bins.claude = READY_BINS.claude!;
        return true;
      },
    });
    const t = scriptedIO();
    const r = await runWizard({ sys: m.sys, io: t.io, mode: "yes" });
    expect(t.prompts).toEqual([]);
    expect(m.runs).toEqual(["pnpm install", "npm install --global @salesforce/cli", "npm install --global @anthropic-ai/claude-code"]);
    expect(t.output()).toContain("Skipped under --yes (login opens your browser)");
    expect(r.ok).toBe(true);
  });
});

describe("runWizard — AI copy writer", () => {
  it("comments out the template's placeholder key instead of letting every API call fail", async () => {
    const m = machine({ bins: READY_BINS, files: { ...INSTALLED, ".env": "PORT=8787\nANTHROPIC_API_KEY=sk-ant-...\n" } });
    await runWizard({ sys: m.sys, io: scriptedIO(["y"]).io, mode: "interactive" });
    expect(m.files[at(".env")]).toBe("PORT=8787\n# ANTHROPIC_API_KEY=sk-ant-...\n");
  });

  it("declining the claude CLI offers to create .env from the template (default no)", async () => {
    const m = machine({ bins: { pnpm: READY_BINS.pnpm!, sf: READY_BINS.sf!, npm: () => ({}) }, files: INSTALLED });
    await runWizard({ sys: m.sys, io: scriptedIO(["n", "y"]).io, mode: "interactive" });
    expect(m.runs).toEqual([]);
    expect(m.files[at(".env")]).toBe("# Anthropic API key\n# ANTHROPIC_API_KEY=sk-ant-...\n");
  });
});
