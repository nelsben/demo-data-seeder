// packages/engine/src/introspect/sf-errors.ts
//
// Turn the two `sf` failures a first-time user actually hits into an instruction instead of
// a stack-trace fragment:
//   • the CLI isn't installed / on PATH  → Node's `spawn sf ENOENT`
//   • the --org alias isn't authenticated → sf's "Parsing --target-org … No authorization
//     information found for <alias>" envelope message
// Everything else passes through unchanged. Both rewritten messages point at `node bin/setup.js`,
// the setup wizard that installs the CLI and walks through `sf org login web`.

export const SETUP_HINT = "Run `node bin/setup.js` to set it up.";

const SF_MISSING_PREFIX = "The Salesforce CLI (`sf`) isn't installed or isn't on your PATH.";
const NOT_AUTHED_RE = /No authori[sz]ation information found for ([^\s.]+)/i;
const NOT_AUTHED_MARK = "isn't authenticated with the Salesforce CLI.";

/** The message for a missing `sf` binary. */
export function sfMissingMessage(): string {
  return `${SF_MISSING_PREFIX} ${SETUP_HINT} (Or install it yourself: npm install --global @salesforce/cli)`;
}

/** The message for an org alias the CLI has no auth for. */
export function orgNotAuthedMessage(alias: string): string {
  return `Org "${alias}" ${NOT_AUTHED_MARK} See your logged-in orgs with \`sf org list\`, or log in with \`sf org login web --alias ${alias}\`. ${SETUP_HINT}`;
}

/** Is this a Node spawn error for a binary that doesn't exist? */
export function isEnoent(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Rewrite a raw `sf` failure into an actionable message. `err` is the child-process error (if any),
 * `text` is whatever sf said (envelope `message`, or stderr). Unrecognized failures fall back to
 * `fallback` (or `text`), untouched.
 */
export function explainSfFailure(err: unknown, text: string | undefined, fallback?: string): string {
  if (isEnoent(err)) return sfMissingMessage();
  const m = text ? NOT_AUTHED_RE.exec(text) : null;
  if (m?.[1]) return orgNotAuthedMessage(m[1]);
  return fallback ?? text ?? (err instanceof Error ? err.message : "sf failed");
}

/**
 * Is `message` one of the two setup problems above (possibly behind a probe's "limits: " prefix)?
 * profile-org uses this to fail loudly instead of writing a profile of an org it never reached.
 */
export function isSfSetupProblem(message: string): boolean {
  return message.includes(SF_MISSING_PREFIX) || message.includes(NOT_AUTHED_MARK);
}
