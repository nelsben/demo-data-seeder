// packs/salescloud/src/anchors.ts
//
// Real-company anchors — the BRIEF's "50 real public-company anchors" axis. ~50
// well-known public companies spanning 18 industries. Using real names as the
// PROSPECT in fictional demo deals is standard demo practice; the contacts, emails,
// and amounts are all fictional/generated. No financial claims are asserted here —
// only public name + sector + a web domain for plausible email addresses.
//
// Every `sfIndustry` is a VALID standard Account.Industry picklist value, so loads are
// FLS/picklist-correct. generate() assigns anchors deterministically (distinct until
// exhausted), so a run's Accounts read like a real, varied pipeline — and the industry
// spread widens the variability matrix the BRIEF calls for.

export interface Anchor {
  name: string;
  /** Descriptive sector (for previews/copy intent). */
  sector: string;
  /** A VALID standard Account.Industry picklist value (load-correct). */
  sfIndustry: string;
  domain: string;
  /**
   * True for an anchor whose OWN product IS a data/analytics/integration platform — the exact category
   * SELLER_PITCH (generate.ts) pitches. Grounding wording can't fix this: any foreground deal landing on
   * one of these reads as pitching the prospect their own product space. Excluded from the foreground
   * round-robin pool (see generate.ts); left in this list since it's still a valid company reference.
   */
  selfProductRisk?: boolean;
}

export const ANCHORS: readonly Anchor[] = [
  // — Technology / SaaS / Security —
  { name: "Snowflake", sector: "Data & Analytics", sfIndustry: "Technology", domain: "snowflake.com", selfProductRisk: true },
  { name: "Datadog", sector: "Observability", sfIndustry: "Technology", domain: "datadoghq.com" },
  { name: "Zscaler", sector: "Cloud Security", sfIndustry: "Technology", domain: "zscaler.com" },
  { name: "HubSpot", sector: "Marketing Software", sfIndustry: "Technology", domain: "hubspot.com" },
  { name: "Confluent", sector: "Data Streaming", sfIndustry: "Technology", domain: "confluent.io", selfProductRisk: true },
  { name: "Samsara", sector: "IoT & Fleet", sfIndustry: "Technology", domain: "samsara.com" },
  { name: "Okta", sector: "Identity & Security", sfIndustry: "Technology", domain: "okta.com" },
  { name: "Atlassian", sector: "Collaboration Software", sfIndustry: "Technology", domain: "atlassian.com" },
  { name: "ServiceNow", sector: "Enterprise Workflow", sfIndustry: "Technology", domain: "servicenow.com" },
  { name: "CrowdStrike", sector: "Cybersecurity", sfIndustry: "Technology", domain: "crowdstrike.com" },
  { name: "MongoDB", sector: "Developer Data Platform", sfIndustry: "Technology", domain: "mongodb.com", selfProductRisk: true },
  { name: "Cloudflare", sector: "Network & Edge", sfIndustry: "Technology", domain: "cloudflare.com" },
  { name: "DocuSign", sector: "Agreement Software", sfIndustry: "Technology", domain: "docusign.com" },
  { name: "Procore", sector: "Construction Tech", sfIndustry: "Construction", domain: "procore.com" },
  // — Finance / Banking / Insurance —
  { name: "Stripe", sector: "Fintech / Payments", sfIndustry: "Finance", domain: "stripe.com" },
  { name: "Block", sector: "Fintech / Payments", sfIndustry: "Finance", domain: "block.xyz" },
  { name: "PayPal", sector: "Digital Payments", sfIndustry: "Finance", domain: "paypal.com" },
  { name: "Coinbase", sector: "Crypto Exchange", sfIndustry: "Finance", domain: "coinbase.com" },
  { name: "Robinhood", sector: "Retail Brokerage", sfIndustry: "Finance", domain: "robinhood.com" },
  { name: "Affirm", sector: "Consumer Lending", sfIndustry: "Finance", domain: "affirm.com" },
  { name: "SoFi", sector: "Consumer Finance", sfIndustry: "Banking", domain: "sofi.com" },
  { name: "Chime", sector: "Neobank", sfIndustry: "Banking", domain: "chime.com" },
  { name: "Lemonade", sector: "Insurtech", sfIndustry: "Insurance", domain: "lemonade.com" },
  { name: "Root", sector: "Auto Insurance", sfIndustry: "Insurance", domain: "joinroot.com" },
  // — Healthcare / Biotech —
  { name: "Veeva Systems", sector: "Life Sciences Software", sfIndustry: "Healthcare", domain: "veeva.com" },
  { name: "Teladoc Health", sector: "Telehealth", sfIndustry: "Healthcare", domain: "teladochealth.com" },
  { name: "Moderna", sector: "Biotech / Vaccines", sfIndustry: "Biotechnology", domain: "modernatx.com" },
  { name: "Guardant Health", sector: "Precision Oncology", sfIndustry: "Biotechnology", domain: "guardanthealth.com" },
  { name: "10x Genomics", sector: "Genomics", sfIndustry: "Biotechnology", domain: "10xgenomics.com" },
  // — Retail / Apparel / Food & Beverage —
  { name: "Shopify", sector: "E-Commerce", sfIndustry: "Retail", domain: "shopify.com" },
  { name: "Chewy", sector: "Pet E-Commerce", sfIndustry: "Retail", domain: "chewy.com" },
  { name: "Wayfair", sector: "Home Goods Retail", sfIndustry: "Retail", domain: "wayfair.com" },
  { name: "Warby Parker", sector: "Eyewear", sfIndustry: "Apparel", domain: "warbyparker.com" },
  { name: "Allbirds", sector: "Footwear", sfIndustry: "Apparel", domain: "allbirds.com" },
  { name: "Sweetgreen", sector: "Fast-Casual Dining", sfIndustry: "Food & Beverage", domain: "sweetgreen.com" },
  { name: "Beyond Meat", sector: "Plant-Based Foods", sfIndustry: "Food & Beverage", domain: "beyondmeat.com" },
  // — Manufacturing / Energy —
  { name: "Rivian", sector: "Electric Vehicles", sfIndustry: "Manufacturing", domain: "rivian.com" },
  { name: "Lucid Motors", sector: "Electric Vehicles", sfIndustry: "Manufacturing", domain: "lucidmotors.com" },
  { name: "Enphase Energy", sector: "Solar Microinverters", sfIndustry: "Energy", domain: "enphase.com" },
  { name: "Sunrun", sector: "Residential Solar", sfIndustry: "Energy", domain: "sunrun.com" },
  { name: "First Solar", sector: "Solar Manufacturing", sfIndustry: "Energy", domain: "firstsolar.com" },
  // — Transportation / Hospitality —
  { name: "DoorDash", sector: "Logistics / Delivery", sfIndustry: "Transportation", domain: "doordash.com" },
  { name: "Uber", sector: "Mobility & Delivery", sfIndustry: "Transportation", domain: "uber.com" },
  { name: "Lyft", sector: "Rideshare", sfIndustry: "Transportation", domain: "lyft.com" },
  { name: "Toast", sector: "Restaurant Tech", sfIndustry: "Hospitality", domain: "toasttab.com" },
  { name: "Airbnb", sector: "Travel & Lodging", sfIndustry: "Hospitality", domain: "airbnb.com" },
  // — Media / Entertainment / Communications / Education —
  { name: "Unity Technologies", sector: "Gaming & Media", sfIndustry: "Media", domain: "unity.com" },
  { name: "Roku", sector: "Streaming Media", sfIndustry: "Media", domain: "roku.com" },
  { name: "Spotify", sector: "Audio Streaming", sfIndustry: "Media", domain: "spotify.com" },
  { name: "Roblox", sector: "Gaming Platform", sfIndustry: "Entertainment", domain: "roblox.com" },
  { name: "Twilio", sector: "Communications APIs", sfIndustry: "Telecommunications", domain: "twilio.com" },
  { name: "RingCentral", sector: "Cloud Communications", sfIndustry: "Telecommunications", domain: "ringcentral.com" },
  { name: "Coursera", sector: "Online Education", sfIndustry: "Education", domain: "coursera.org" },
  { name: "Duolingo", sector: "Language Learning", sfIndustry: "Education", domain: "duolingo.com" },
] as const;
