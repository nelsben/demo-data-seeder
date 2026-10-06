// cascade_probe.apex — validates the trigger cascade in a target org that has downstream automation.
//
// Seeds INPUTS ONLY (Account → Contact → Opportunity → EmailMessages with at-risk-budget /
// champion-silence content), then lets the org's REAL trigger/automation cascade derive
// whatever outputs it produces (signals, briefs, scores — whatever the installed app computes).
// We assert nothing here — we just plant the inputs and print the Opp Id; a follow-up
// SOQL confirms the org's automation produced its outputs. Idempotent-ish: re-running
// makes a new dated probe Account so it never collides.
//
// Run: sf apex run -f scripts/validate/cascade_probe.apex --target-org <alias>

String stamp = String.valueOf(Datetime.now().getTime());

Account a = new Account(Name = 'Meridian Systems [PROBE ' + stamp + ']', Industry = 'Technology');
insert a;

Contact champion = new Contact(AccountId = a.Id, FirstName = 'Dana', LastName = 'Whitfield', Title = 'VP Engineering', Email = 'dana.whitfield@meridian.example');
Contact eb = new Contact(AccountId = a.Id, FirstName = 'Marcus', LastName = 'Reyes', Title = 'CFO', Email = 'marcus.reyes@meridian.example');
insert new List<Contact>{ champion, eb };

Opportunity opp = new Opportunity(
  Name = 'Meridian Systems — Platform Expansion [PROBE ' + stamp + ']',
  AccountId = a.Id,
  StageName = 'Negotiation/Review',
  Amount = 1200000,
  CloseDate = Date.today().addDays(38)
);
insert opp;

insert new List<OpportunityContactRole>{
  new OpportunityContactRole(OpportunityId = opp.Id, ContactId = champion.Id, Role = 'Technical Buyer', IsPrimary = true),
  new OpportunityContactRole(OpportunityId = opp.Id, ContactId = eb.Id, Role = 'Economic Buyer')
};

// Six emails over ~3 weeks: positive -> budget concern -> champion goes quiet.
// Specific numbers + names + dates (the voice spec) so the LLM has real evidence to extract.
Datetime t0 = Datetime.now().addDays(-21);
List<EmailMessage> emails = new List<EmailMessage>{
  new EmailMessage(
    RelatedToId = opp.Id, Incoming = true, Status = '0', MessageDate = t0,
    FromAddress = 'dana.whitfield@meridian.example', ToAddress = 'ae@acme.example',
    Subject = 'Re: Platform expansion — next steps',
    TextBody = 'Dana here. The team ran the pilot last Thursday and the throughput numbers held up — we pushed 4.2M events through without a hiccup. I want to move this forward. Can you get me a draft SOW so I can socialize it internally?'
  ),
  new EmailMessage(
    RelatedToId = opp.Id, Incoming = false, Status = '3', MessageDate = t0.addDays(3),
    FromAddress = 'ae@acme.example', ToAddress = 'dana.whitfield@meridian.example',
    Subject = 'SOW draft + rollout timeline',
    TextBody = 'Dana — SOW attached. We scoped a 12-week rollout starting in Q3, $1.2M ARR for the expansion tier. Who owns budget sign-off on your side? Want to make sure we loop them in early.'
  ),
  new EmailMessage(
    RelatedToId = opp.Id, Incoming = true, Status = '0', MessageDate = t0.addDays(7),
    FromAddress = 'dana.whitfield@meridian.example', ToAddress = 'ae@acme.example',
    Subject = 'Re: SOW draft + rollout timeline',
    TextBody = 'Marcus in finance owns the sign-off. I flagged the $1.2M number to him on Tuesday and he had concerns about the size relative to this year\'s budget. He wants to understand the ROI case before we go further. Can you put together a one-pager on payback period?'
  ),
  new EmailMessage(
    RelatedToId = opp.Id, Incoming = true, Status = '0', MessageDate = t0.addDays(9),
    FromAddress = 'marcus.reyes@meridian.example', ToAddress = 'ae@acme.example',
    Subject = 'Budget concern on the expansion',
    TextBody = 'This is Marcus, CFO. I have to be direct — $1.2M is above what we\'ve allocated for tooling this fiscal year. We capped that line at $800K in our last planning cycle. Unless the payback is under 9 months I don\'t see how I get this approved before close.'
  ),
  new EmailMessage(
    RelatedToId = opp.Id, Incoming = false, Status = '3', MessageDate = t0.addDays(12),
    FromAddress = 'ae@acme.example', ToAddress = 'dana.whitfield@meridian.example',
    Subject = 'Payback one-pager + a path on budget',
    TextBody = 'Dana — payback one-pager attached: we model 7.5-month payback driven by the support-deflection savings. I also sketched a phased option that lands year-one spend near $820K. Can we get 20 minutes with you and Marcus this week to walk through it?'
  ),
  new EmailMessage(
    RelatedToId = opp.Id, Incoming = false, Status = '3', MessageDate = t0.addDays(18),
    FromAddress = 'ae@acme.example', ToAddress = 'dana.whitfield@meridian.example',
    Subject = 'Checking in — still on for this week?',
    TextBody = 'Dana — haven\'t heard back on scheduling the walkthrough. I know Marcus\'s budget question is the blocker; I\'d really like to get in front of it together before the 38-day close slips. Are you free Thursday or Friday?'
  )
};
insert emails;

System.debug('PROBE_OPP_ID=' + opp.Id);
System.debug('PROBE_ACCOUNT=' + a.Name);
System.debug('Seeded ' + emails.size() + ' emails on the probe opp — the org's automation should now react to them.');
