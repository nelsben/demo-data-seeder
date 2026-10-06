// packs/salescloud/src/grounding.ts
//
// Per-anchor GROUNDING fact-packs — the cure for the "interchangeable company" tell the
// realism audit flagged (a Snowflake deal that says nothing about data warehousing reads as
// wallpaper). Each pack is a few PUBLIC, non-financial facts about what the prospect company
// actually does, so generated emails can reference its real world ("the warehouse-credit
// pilot", "chargeback exposure") instead of generic "expansion / ROI" prose.
//
// The marquee (LLM) tier weaves ONE of these into each thread; the static floor can borrow a
// single detail too. Curated for the well-known anchors; the long tail falls back to a
// sector template keyed on Account.Industry, then a generic default — so every anchor always
// resolves to *something* plausible. NO real employee names, NO financial claims: only what
// the company publicly does, sells, and plausibly worries about.

import type { Anchor } from "./anchors.js";

export interface AnchorGrounding {
  /** One phrase for what the company does (public knowledge). */
  does: string;
  /** A real product/offering or two (public). */
  products: string[];
  /** A plausible internal team that would own a vendor evaluation. */
  buyingDept: string;
  /** A concrete operational pain in their world a deal could speak to. */
  painPhrase: string;
  /**
   * The competing vendors in OUR deal — texture for the Competition signal. Always resolves to
   * the SELLER's competitive set (horizontal BI/data/analytics/integration vendors we lose deals
   * to), NEVER the prospect's own-category industry rivals. A real competitor here is another
   * data-platform vendor the buyer is also evaluating, not a crypto exchange or an ITSM tool.
   * The per-anchor literals below are vestigial; `resolveGrounding` overrides them with
   * SELLER_COMPETITORS so a Coinbase deal never reads "competitive eval against Kraken".
   */
  competitors: string[];
}

/**
 * The SELLER's competitive set — the real horizontal BI/data/analytics/integration vendors our
 * platform actually competes against. Every resolved grounding uses this (minus the prospect's
 * own name, in the near-zero chance an anchor is itself a BI vendor) so the Competition signal
 * always frames a rival DATA-PLATFORM vendor, never the prospect's industry rival.
 */
export const SELLER_COMPETITORS = ["Tableau", "Looker", "Power BI", "ThoughtSpot", "Sigma", "Domo", "Qlik", "Mode Analytics"];

/** Hand-curated for the marquee anchors (accurate public facts). */
const CURATED: Record<string, AnchorGrounding> = {
  Snowflake: { does: "cloud data warehousing", products: ["the Data Cloud", "Snowpark"], buyingDept: "Data Platform", painPhrase: "unifying pipeline, consumption, and finance reporting across its sales and revenue orgs", competitors: ["Databricks", "BigQuery"] },
  Stripe: { does: "online payments infrastructure", products: ["Payments", "Radar"], buyingDept: "Payments & Finance", painPhrase: "unifying product, revenue, and risk data across business lines", competitors: ["Adyen", "Braintree"] },
  Block: { does: "payments and financial services (Square, Cash App)", products: ["Square", "Cash App"], buyingDept: "Data & Analytics", painPhrase: "unifying product, risk, and finance data across the Square and Cash App business units", competitors: ["PayPal", "Stripe"] },
  Datadog: { does: "cloud observability", products: ["APM", "Log Management"], buyingDept: "Platform Engineering", painPhrase: "fragmented GTM and customer-health reporting across siloed internal systems", competitors: ["New Relic", "Grafana"] },
  Shopify: { does: "commerce platform software", products: ["Shopify Plus", "Shop Pay"], buyingDept: "Merchant Operations", painPhrase: "reconciling revenue, usage, and merchant-success data across its internal go-to-market teams", competitors: ["BigCommerce", "Adobe Commerce"] },
  Twilio: { does: "communications APIs", products: ["Programmable Messaging", "SendGrid"], buyingDept: "Developer Platform", painPhrase: "consolidating usage, billing, and customer-health data across its internal product lines", competitors: ["Vonage", "MessageBird"] },
  Zscaler: { does: "cloud security (zero trust)", products: ["the Zero Trust Exchange"], buyingDept: "Security & IT", painPhrase: "fragmented pipeline and renewal reporting across its internal sales and finance teams", competitors: ["Palo Alto Networks", "Netskope"] },
  HubSpot: { does: "inbound marketing and CRM", products: ["Marketing Hub", "Sales Hub"], buyingDept: "Revenue Operations", painPhrase: "reconciling revenue, usage, and finance data across its internal business units", competitors: ["Salesforce", "Marketo"] },
  DoorDash: { does: "last-mile delivery logistics", products: ["the Marketplace", "Drive"], buyingDept: "Logistics Operations", painPhrase: "consolidating revenue, ops, and finance reporting across its internal regional teams", competitors: ["Uber Eats", "Instacart"] },
  "Veeva Systems": { does: "life-sciences cloud software", products: ["Veeva CRM", "Vault"], buyingDept: "Commercial Operations", painPhrase: "fragmented commercial reporting across field, medical, and market-access teams", competitors: ["IQVIA", "Salesforce"] },
  Toast: { does: "restaurant point-of-sale software", products: ["Toast POS", "Toast Payroll"], buyingDept: "Restaurant Operations", painPhrase: "unifying revenue, usage, and customer-success reporting across its internal go-to-market teams", competitors: ["Square", "Clover"] },
  Confluent: { does: "data streaming (Kafka)", products: ["Confluent Cloud"], buyingDept: "Data Platform", painPhrase: "consolidating consumption, pipeline, and finance reporting across its internal revenue orgs", competitors: ["AWS MSK", "Redpanda"] },
  Okta: { does: "identity and access management", products: ["Workforce Identity", "Auth0"], buyingDept: "Security & IT", painPhrase: "consolidating operational and revenue reporting across internal teams", competitors: ["Microsoft Entra", "Ping Identity"] },
  Atlassian: { does: "team collaboration software", products: ["Jira", "Confluence"], buyingDept: "Engineering Operations", painPhrase: "reconciling revenue, usage, and finance reporting across its internal cloud and server business lines", competitors: ["Monday.com", "Linear"] },
  ServiceNow: { does: "enterprise workflow automation", products: ["ITSM", "HR Service Delivery"], buyingDept: "IT Operations", painPhrase: "reconciling revenue, usage, and support data across its internal business units", competitors: ["BMC", "Zendesk"] },
  CrowdStrike: { does: "endpoint security", products: ["the Falcon platform"], buyingDept: "Security Operations", painPhrase: "consolidating pipeline, renewal, and finance reporting across its internal go-to-market teams", competitors: ["SentinelOne", "Microsoft Defender"] },
  MongoDB: { does: "a developer data platform", products: ["Atlas"], buyingDept: "Data Platform", painPhrase: "unifying consumption, pipeline, and finance reporting across its internal revenue orgs", competitors: ["Postgres", "DynamoDB"] },
  Coinbase: { does: "crypto exchange and custody", products: ["Coinbase Prime"], buyingDept: "Trading & Compliance", painPhrase: "reconciling revenue, transaction, and finance data across its internal business units", competitors: ["Kraken", "Gemini"] },
  Rivian: { does: "electric-vehicle manufacturing", products: ["the R1T", "the R1S"], buyingDept: "Manufacturing Operations", painPhrase: "consolidating production, supply-chain, and finance reporting across its internal operations teams", competitors: ["Tesla", "Lucid Motors"] },
  Moderna: { does: "mRNA therapeutics", products: ["Spikevax"], buyingDept: "R&D and Manufacturing", painPhrase: "reconciling R&D, manufacturing, and finance reporting across its internal operations teams", competitors: ["Pfizer", "BioNTech"] },
};

/** Long-tail fallback by Account.Industry — generic but plausible per sector. */
const BY_INDUSTRY: Record<string, AnchorGrounding> = {
  Technology: { does: "enterprise software", products: ["its core platform"], buyingDept: "Platform Engineering", painPhrase: "tool sprawl and integration overhead", competitors: ["incumbent suites"] },
  // Internal back-office pains (NOT the company's own product) — a payments/fintech company tagged Finance
  // must not be pitched "reconciliation" (that IS its product); a bank must not be pitched "KYC/onboarding".
  Finance: { does: "financial services", products: ["its core platform"], buyingDept: "Finance & Operations", painPhrase: "consolidating financial and operational data across business units", competitors: ["legacy providers"] },
  Banking: { does: "consumer banking", products: ["its banking app"], buyingDept: "Digital Banking", painPhrase: "fragmented operational reporting across digital and branch channels", competitors: ["incumbent banks"] },
  Insurance: { does: "insurance products", products: ["its policy platform"], buyingDept: "Claims & Underwriting", painPhrase: "claims-processing cycle time", competitors: ["legacy carriers"] },
  Healthcare: { does: "healthcare services", products: ["its care platform"], buyingDept: "Clinical Operations", painPhrase: "patient-data interoperability", competitors: ["incumbent EHR vendors"] },
  Biotechnology: { does: "biotech R&D", products: ["its research pipeline"], buyingDept: "R&D Operations", painPhrase: "research-data turnaround", competitors: ["established biopharma"] },
  Retail: { does: "retail", products: ["its storefront"], buyingDept: "Merchant Operations", painPhrase: "inventory and fulfillment at peak", competitors: ["marketplace incumbents"] },
  Apparel: { does: "consumer apparel", products: ["its product lines"], buyingDept: "Merchandising", painPhrase: "demand forecasting and returns", competitors: ["established brands"] },
  "Food & Beverage": { does: "food and beverage", products: ["its product lines"], buyingDept: "Supply Chain", painPhrase: "supply-chain freshness and cost", competitors: ["packaged-goods incumbents"] },
  Manufacturing: { does: "manufacturing", products: ["its product lines"], buyingDept: "Manufacturing Operations", painPhrase: "production throughput and supply chain", competitors: ["established manufacturers"] },
  Energy: { does: "clean energy", products: ["its energy products"], buyingDept: "Operations & Finance", painPhrase: "project-cost and field-operations reporting across teams", competitors: ["incumbent ops tools"] },
  Transportation: { does: "logistics and mobility", products: ["its platform"], buyingDept: "Operations & RevOps", painPhrase: "manual operational reporting across dispersed regional teams", competitors: ["incumbent ops tools"] },
  Hospitality: { does: "hospitality", products: ["its platform"], buyingDept: "Operations & Finance", painPhrase: "labor-cost forecasting and reporting across many locations", competitors: ["incumbent ops tools"] },
  Media: { does: "digital media", products: ["its platform"], buyingDept: "Revenue & Data", painPhrase: "reconciling revenue data across ad, subscription, and licensing systems", competitors: ["incumbent reporting tools"] },
  Entertainment: { does: "interactive entertainment", products: ["its platform"], buyingDept: "Product Operations", painPhrase: "scattered live-ops and product metrics across teams", competitors: ["incumbent analytics tools"] },
  Telecommunications: { does: "communications services", products: ["its network services"], buyingDept: "Operations & Finance", painPhrase: "cost and operational reporting across network and finance teams", competitors: ["incumbent reporting tools"] },
  Education: { does: "online education", products: ["its learning platform"], buyingDept: "Operations & Data", painPhrase: "operational reporting across enrollment, content, and support teams", competitors: ["incumbent reporting tools"] },
  Construction: { does: "construction technology", products: ["its platform"], buyingDept: "Project Operations", painPhrase: "project-schedule slippage", competitors: ["legacy tools"] },
};

const GENERIC: AnchorGrounding = { does: "its business", products: ["its core product"], buyingDept: "Operations", painPhrase: "operational efficiency at scale", competitors: ["established incumbents"] };

/**
 * Resolve grounding for an anchor: curated → sector template → generic. Always returns a pack.
 *
 * `competitors` is ALWAYS overridden to the SELLER's competitive set (the BI/data/analytics
 * vendors WE lose deals to) — never the prospect's own-category rivals — so the Competition
 * signal can't frame a crypto-exchange or ITSM rival as the vendor in our deal. The prospect's
 * own name is filtered out (case-insensitive) on the off chance an anchor is itself a BI vendor.
 */
export function resolveGrounding(anchor: Pick<Anchor, "name" | "sfIndustry">): AnchorGrounding {
  const base = CURATED[anchor.name] ?? BY_INDUSTRY[anchor.sfIndustry] ?? GENERIC;
  const lowerName = anchor.name.toLowerCase();
  return { ...base, competitors: SELLER_COMPETITORS.filter((c) => c.toLowerCase() !== lowerName) };
}
