// Run monitoring for every organization and sandbox that has not expired.
// Used by the nightly sweep and after each sanctions list refresh.
// Standalone: npx tsx jobs/run-monitor-all.ts [trigger]   (from api/, trigger defaults to "manual_all")
import { pathToFileURL } from 'node:url';
import type { Sql } from '../src/db';
import { runMonitor, type MonitorSummary } from '../src/monitor';
import { openPepReviews } from '../src/pep';
import { db, log, pool } from './lib';

export type WorkspaceResult = { id: string; name: string; ok: boolean; summary?: MonitorSummary; error?: string; ms: number };

export async function runMonitorAll(sql: Sql, trigger: string, concurrency = 4): Promise<WorkspaceResult[]> {
  const workspaces = await sql`select id, name from workspaces where expires_at is null or expires_at > now() order by created_at`;
  log(`Monitoring ${workspaces.length} active workspace${workspaces.length === 1 ? '' : 's'} (trigger: ${trigger})`);
  return pool(workspaces, concurrency, async (w: any): Promise<WorkspaceResult> => {
    const start = Date.now();
    try {
      const summary = await runMonitor(sql, w.id, trigger, { admin: sql });
      // PEP list: reviews and work items, after the standing computation and outside its query budget (a PEP is not frozen).
      try {
        const investors = await sql`select id, name from investors where workspace_id = ${w.id}`;
        const opened = await openPepReviews(sql, w.id, investors, 'system:monitor');
        if (opened.length) log(`  ${w.name.slice(0, 40)}: ${opened.length} PEP review${opened.length === 1 ? '' : 's'} opened`);
      } catch (e: any) { log(`  ${w.name.slice(0, 40)}: PEP sweep failed: ${e?.message ?? e}`); }
      return { id: w.id, name: w.name, ok: true, summary, ms: Date.now() - start };
    } catch (e: any) {
      return { id: w.id, name: w.name, ok: false, error: e?.message ?? String(e), ms: Date.now() - start };
    }
  });
}

export function printResults(results: WorkspaceResult[]) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const sum = (k: keyof MonitorSummary) => ok.reduce((n, r) => n + (r.summary?.[k] ?? 0), 0);
  for (const r of results) {
    if (r.ok) log(`  ${r.name.slice(0, 40).padEnd(40)} holders ${String(r.summary!.holders_checked).padStart(4)}  changes ${String(r.summary!.changes).padStart(3)}  opened ${String(r.summary!.items_opened).padStart(3)}  closed ${String(r.summary!.items_closed).padStart(3)}  ${r.ms} ms`);
    else log(`  ${r.name.slice(0, 40).padEnd(40)} FAILED: ${r.error}`);
  }
  log(`Done: ${ok.length} workspaces checked, ${sum('holders_checked')} holdings, ${sum('changes')} status changes, ${sum('items_opened')} work items opened, ${sum('items_closed')} closed${failed.length ? `, ${failed.length} failed` : ''}.`);
  return failed.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sql = db();
  const failed = printResults(await runMonitorAll(sql, process.argv[2] || 'manual_all'));
  process.exit(failed ? 1 : 0);
}
