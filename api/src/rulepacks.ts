// Registers the rule packs added after launch with the API. Importing this module once (for example
// `import './rulepacks';` at the API entry) lets issuers add GB, JP, AE-ADGM, LU and IE to a fund's
// distribution list: lawDefaults() in ./seed reads EXTRA_LAW for jurisdictions the launch funds lack.
import { NEW_LAW, RULE_PACKS, packsAsOf, type LawRule } from '../../src/proto/rulepacks';
import { EXTRA_LAW } from './seed';
import { PLACEMENT_LIMITS, placementLimitsFor } from './placement-limits';

let registered = false;
/** Adds the new jurisdictions' law rules to EXTRA_LAW. Safe to call more than once. */
export function registerRulePackLaw(): Record<string, LawRule> {
  if (!registered) { Object.assign(EXTRA_LAW, NEW_LAW); registered = true; }
  return EXTRA_LAW;
}
registerRulePackLaw();

/** Jurisdictions an issuer can add to a fund because a rule pack covers them (launch funds plus EXTRA_LAW). */
export const SUPPORTED_DISTRIBUTION = ['SG', 'HK', 'CH', 'DE', 'AE-DIFC', 'US', ...Object.keys(NEW_LAW)];

/** Pack versions in force on a date from the static list, for use before the database is migrated. */
export const staticPacksAsOf = (date: string) => packsAsOf(RULE_PACKS, date);

export { NEW_LAW, RULE_PACKS, PLACEMENT_LIMITS, placementLimitsFor };
