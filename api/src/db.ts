import { neon } from '@neondatabase/serverless';

/** The query surface every module uses. Both the tenant wrapper and a raw neon client satisfy it. */
export type Sql = {
  (strings: TemplateStringsArray, ...values: any[]): PromiseLike<any[]> & { catch?: any };
  query(text: string, params?: any[]): PromiseLike<any[]>;
  transaction(queries: any[]): Promise<any[][]>;
};

/**
 * Driver selection. The Worker talks to Neon over HTTP. A local server (api/server.mjs) or a job can instead
 * register a node-postgres factory with setDriver(), so the same code runs against any Postgres with no proxy.
 */
type Driver = (url: string) => any;
let driver: Driver = (url) => neon(url);
export function setDriver(d: Driver) { driver = d; }

/** Builds a neon-shaped client (tagged template, query(), transaction()) on top of node-postgres. */
export function pgDriver(pg: any): Driver {
  const pools = new Map<string, any>();
  return (url: string) => {
    if (!pools.has(url)) pools.set(url, new pg.Pool({ connectionString: url.replace(/[?&]sslmode=[a-z-]+/, ''), max: 8, ssl: /neon\.tech|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined }));
    const pool = pools.get(url);
    const toText = (strings: TemplateStringsArray, values: any[]) => ({ text: strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), ''), params: values });
    const lazy = (q: { text: string; params: any[] }) => ({
      __pq: q,
      then(res?: any, rej?: any) { return pool.query(q.text, q.params).then((r: any) => r.rows).then(res, rej); },
      catch(rej: any) { return pool.query(q.text, q.params).then((r: any) => r.rows).catch(rej); },
    });
    const f: any = (strings: TemplateStringsArray, ...values: any[]) => lazy(toText(strings, values));
    f.query = (text: string, params: any[] = []) => lazy({ text, params });
    f.transaction = async (queries: any[]) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out: any[][] = [];
        for (const q of queries) { const r = await client.query((q.__pq ?? q).text, (q.__pq ?? q).params); out.push(r.rows); }
        await client.query('commit');
        return out;
      } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
    };
    return f;
  };
}

/** Owner connection. Bypasses row-level security: only for auth lookups, sandbox creation, cross-tenant shares and jobs. */
export function adminSql(url: string): Sql {
  return driver(url) as unknown as Sql;
}

/**
 * Tenant connection. Connects as a role without BYPASSRLS, and wraps every query in a
 * transaction that first sets app.ws, so Postgres itself limits each statement to one organization.
 * Queries stay lazy, so they can still be passed to transaction() before they run.
 */
export function tenantSql(url: string, ws: string): Sql {
  const raw: any = driver(url);
  const setWs = () => raw`select set_config('app.ws', ${ws}, true)`;
  const lazy = (q: any) => {
    const run = () => raw.transaction([setWs(), q]).then((r: any[][]) => r[1]);
    return {
      __q: q,
      then(res?: any, rej?: any) { return run().then(res, rej); },
      catch(rej: any) { return run().catch(rej); },
    };
  };
  const f: any = (strings: TemplateStringsArray, ...values: any[]) => lazy(raw(strings, ...values));
  f.query = (text: string, params: any[] = []) => lazy(raw.query(text, params));
  f.transaction = (queries: any[]) => raw.transaction([setWs(), ...queries.map((x: any) => x?.__q ?? x)]).then((r: any[][]) => r.slice(1));
  return f as Sql;
}
