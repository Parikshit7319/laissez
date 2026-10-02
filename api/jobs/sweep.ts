// Nightly monitoring sweep: re-screens every holder in every active workspace, catches credentials that
// are about to expire or have lapsed, and opens or closes work items. Run from api/: npx tsx jobs/sweep.ts
import { db, log } from './lib';
import { runMonitorAll, printResults } from './run-monitor-all';

const started = Date.now();
const sql = db();
log('Nightly monitoring sweep');
const failed = printResults(await runMonitorAll(sql, 'nightly'));
log(`Sweep finished in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
if (failed) {
  console.error(`${failed} workspace${failed === 1 ? '' : 's'} could not be monitored. See the errors above; the others were updated.`);
  process.exit(1);
}
