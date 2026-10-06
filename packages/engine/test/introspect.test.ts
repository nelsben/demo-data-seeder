import { describe, it, expect } from "vitest";
import { CapabilityProfile } from "@dataseed/core";
import type { SfClient, DescribeResult, LimitRow, RestResponse } from "../src/introspect/sf-client.js";
import { assembleProfile } from "../src/introspect/profile.js";
import {
  probeLimits,
  probeOrgInfo,
  probeLicensing,
  probeObjects,
  probeExistingData,
  probeDataCloud,
} from "../src/introspect/probes.js";

/** A configurable in-memory SfClient — the seam that makes probes testable with no org. */
class MockSfClient implements SfClient {
  readonly org = "mock";
  constructor(
    private readonly cfg: {
      limits?: LimitRow[];
      queries?: Record<string, unknown[]>;
      describes?: Record<string, DescribeResult>;
      rest?: Record<string, RestResponse>;
      throwOn?: Partial<Record<"limits" | "query" | "describe" | "restGet", boolean>>;
    },
  ) {}

  async query<T = Record<string, unknown>>(soql: string): Promise<T[]> {
    if (this.cfg.throwOn?.query) throw new Error("boom: query");
    // match by a substring key
    for (const [needle, rows] of Object.entries(this.cfg.queries ?? {})) {
      if (soql.includes(needle)) return rows as T[];
    }
    return [];
  }
  async limits(): Promise<LimitRow[]> {
    if (this.cfg.throwOn?.limits) throw new Error("boom: limits");
    return this.cfg.limits ?? [];
  }
  async describe(sobject: string): Promise<DescribeResult> {
    if (this.cfg.throwOn?.describe) throw new Error("boom: describe");
    const d = this.cfg.describes?.[sobject];
    if (!d) throw new Error(`NOT_FOUND: ${sobject}`); // absent object → describe throws
    return d;
  }
  async restGet(path: string): Promise<RestResponse> {
    if (this.cfg.throwOn?.restGet) throw new Error("boom: rest");
    return this.cfg.rest?.[path] ?? { ok: false, body: "no stub" };
  }
}

describe("probeLimits", () => {
  it("computes a record budget from data storage (20% reserve, 512 rec/MB)", async () => {
    const { patch } = await probeLimits(
      new MockSfClient({ limits: [{ name: "DataStorageMB", max: 1000, remaining: 1000 }] }),
    );
    // 1000 MB * 512 * 0.8 = 409600
    expect(patch.recordBudget).toBe(409_600);
    expect(patch.limits?.dataStorageMB?.remaining).toBe(1000);
  });

  it("fail-open: a throwing client yields a gap, not an exception", async () => {
    const { patch, gaps } = await probeLimits(new MockSfClient({ throwOn: { limits: true } }));
    expect(patch).toEqual({});
    expect(gaps[0]).toMatch(/limits:/);
  });
});

describe("probeOrgInfo", () => {
  it("reads edition / sandbox / namespace", async () => {
    const { patch } = await probeOrgInfo(
      new MockSfClient({
        queries: { "FROM Organization": [{ OrganizationType: "Developer Edition", IsSandbox: false, NamespacePrefix: null }] },
      }),
    );
    expect(patch.edition).toBe("Developer Edition");
    expect(patch.isSandbox).toBe(false);
    expect(patch.namespacePrefix).toBeNull();
  });
});

describe("probeLicensing", () => {
  it("derives the anthropic copy-provider hint on a GenAI-licensed org + DC-licensed + installed packages", async () => {
    const { patch } = await probeLicensing(
      new MockSfClient({
        queries: {
          "FROM PermissionSetLicense": [{ DeveloperName: "GenieDataPlatformStarterPsl" }, { DeveloperName: "EinsteinGPTCopilotPsl" }],
          "FROM InstalledSubscriberPackage": [
            { SubscriberPackage: { Name: "Example Package", NamespacePrefix: "example" }, SubscriberPackageVersionId: "04t000000000000" },
          ],
        },
      }),
    );
    // "anthropic", not "einstein" — no engine-side provider ever implemented "einstein" (regression: the
    // profile used to advertise a provider that would silently fall through to the real chain at fill time).
    expect(patch.copyProvider).toBe("anthropic");
    expect(patch.dataCloud?.licensed).toBe(true);
    expect(patch.installedPackages).toEqual([{ name: "Example Package", namespacePrefix: "example", versionId: "04t000000000000" }]);
  });

  it("defaults copy provider to static when no GenAI PSL", async () => {
    const { patch } = await probeLicensing(new MockSfClient({ queries: { "FROM PermissionSetLicense": [] } }));
    expect(patch.copyProvider).toBe("static");
    expect(patch.dataCloud?.licensed).toBe(false);
  });
});

describe("probeObjects", () => {
  const describes: Record<string, DescribeResult> = {
    Account: { name: "Account", fields: [{ name: "Name", type: "string", createable: true, updateable: true, nillable: false }] },
    Signal_Event__c: {
      name: "Signal_Event__c",
      fields: [
        { name: "Source_Object_Type__c", type: "picklist", createable: true, updateable: true, nillable: false, restrictedPicklist: true, picklistValues: [{ value: "EmailMessage", active: true }, { value: "Old", active: false }] },
        { name: "System_Locked__c", type: "boolean", createable: false, updateable: false, nillable: false, custom: true },
      ],
    },
  };

  it("marks present/absent and extracts active restricted-picklist values + blocked required fields", async () => {
    const { patch } = await probeObjects(new MockSfClient({ describes }), ["Account", "Signal_Event__c", "Ghost__c"]);
    const byName = new Map(patch.objects!.map((o) => [o.apiName, o]));
    expect(byName.get("Account")!.present).toBe(true);
    expect(byName.get("Ghost__c")!.present).toBe(false); // describe threw → absent
    // required + not createable → blocked
    expect(byName.get("Signal_Event__c")!.blockedRequiredFields).toContain("System_Locked__c");
    // only ACTIVE picklist values are kept
    expect(patch.livePicklists!["Signal_Event__c.Source_Object_Type__c"]).toEqual(["EmailMessage"]);
  });
});

describe("probeExistingData", () => {
  it("counts only present objects", async () => {
    const { patch } = await probeExistingData(
      new MockSfClient({ queries: { "FROM Account": [{ cnt: 42 }] } }),
      ["Account", "Missing__c"],
      new Set(["Account"]),
    );
    expect(patch.existingCounts).toEqual({ Account: 42 });
  });
});

describe("probeDataCloud", () => {
  it("licensed + ssot provisioned → available", async () => {
    const { patch } = await probeDataCloud(
      new MockSfClient({ rest: { "/services/data/v62.0/ssot/data-model-objects": { ok: true, body: { dataModelObject: [] } } } }),
      true,
    );
    expect(patch.dataCloud?.available).toBe(true);
  });
  it("licensed but not provisioned → unavailable", async () => {
    const { patch } = await probeDataCloud(
      new MockSfClient({ rest: { "/services/data/v62.0/ssot/data-model-objects": { ok: false, body: "FUNCTIONALITY_NOT_ENABLED" } } }),
      true,
    );
    expect(patch.dataCloud?.available).toBe(false);
  });
  it("unlicensed → unavailable, no callout", async () => {
    const { patch } = await probeDataCloud(new MockSfClient({}), false);
    expect(patch.dataCloud).toMatchObject({ licensed: false, available: false });
  });
  it("licensed but ssot probe THROWS → fail CLOSED (unavailable) + a gap, not a false positive", async () => {
    // PSL presence is not proof of provisioning; an unconfirmable probe must not claim available=true.
    const { patch, gaps } = await probeDataCloud(new MockSfClient({ throwOn: { restGet: true } }), true);
    expect(patch.dataCloud).toMatchObject({ licensed: true, available: false });
    expect(gaps[0]).toMatch(/ssotProbe/);
  });
});

describe("assembleProfile", () => {
  const fullClient = new MockSfClient({
    limits: [{ name: "DataStorageMB", max: 1000, remaining: 500 }],
    queries: {
      "FROM Organization": [{ OrganizationType: "Developer Edition", IsSandbox: false, NamespacePrefix: null }],
      "FROM PermissionSetLicense": [{ DeveloperName: "GenieDataPlatformStarterPsl" }],
      "FROM InstalledSubscriberPackage": [],
      "FROM Account": [{ cnt: 7 }],
    },
    describes: { Account: { name: "Account", fields: [{ name: "Name", type: "string", createable: true, updateable: true, nillable: false }] } },
    rest: { "/services/data/v62.0/ssot/data-model-objects": { ok: true, body: { dataModelObject: [] } } },
  });

  it("merges all probes into a schema-valid profile (dataCloud refinement wins over licensing seed)", async () => {
    const profile = await assembleProfile(fullClient, { objects: ["Account", "Ghost__c"], capturedAt: "2026-06-17T00:00:00.000Z" });
    expect(() => CapabilityProfile.parse(profile)).not.toThrow();
    expect(profile.recordBudget).toBe(Math.floor(500 * 512 * 0.8));
    expect(profile.dataCloud?.licensed).toBe(true);
    expect(profile.dataCloud?.available).toBe(true); // refined by dataCloud probe, not the licensing seed
    expect(profile.existingCounts).toEqual({ Account: 7 });
    expect(profile.objects.find((o) => o.apiName === "Ghost__c")?.present).toBe(false);
  });

  it("fail-open: a fully broken client still yields a valid (sparse) profile with gaps", async () => {
    const broken = new MockSfClient({ throwOn: { limits: true, query: true, describe: true, restGet: true } });
    const profile = await assembleProfile(broken, { objects: ["Account"], capturedAt: "2026-06-17T00:00:00.000Z" });
    expect(() => CapabilityProfile.parse(profile)).not.toThrow();
    expect(profile.gaps.length).toBeGreaterThan(0);
    expect(profile.copyProvider).toBe("static"); // schema default survives
  });
});
