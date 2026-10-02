import { neon } from '@neondatabase/serverless';

/** The query surface every module uses. Both the tenant wrapper and a raw neon client satisfy it. */
export type Sql = {
  (strings: TemplateStringsArray, ...values: any[]): PromiseLike<any[]> & { catch?: any };
  query(text: string, params?: any[]): PromiseLike<any[]>;
  transaction(queries: any[]): Promise<any[][]>;
};

/** Owner connection. Bypasses row-level security: only for auth lookups, sandbox creation, cross-tenant shares and jobs. */
export function adminSql(url: string): Sql {
  return neon(url) as unknown as Sql;
}

/**
 * Tenant connection. Connects as a role without BYPASSRLS, and wraps every query in a
 * transaction that first sets app.ws, so Postgres itself limits each statement to one organization.
 * Queries stay lazy, so they can still be passed to transaction() before they run.
 */
export function tenantSql(url: string, ws: string): Sql {
  const raw: any = neon(url);
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
