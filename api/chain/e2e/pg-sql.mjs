// A node-postgres adapter with the same surface as the Neon client the API uses: lazy tagged-template queries,
// .query(text, params) and .transaction([queries]). Test use only.
import pg from 'pg';

export function pgSql(pool) {
  const lazy = (text, params) => {
    let p = null;
    const run = () => (p ??= pool.query(text, params).then((r) => r.rows));
    return { __pg: { text, params }, then: (res, rej) => run().then(res, rej), catch: (rej) => run().catch(rej) };
  };
  const f = (strings, ...values) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`;
    return lazy(text, values);
  };
  f.query = (text, params = []) => lazy(text, params);
  f.transaction = async (queries) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const out = [];
      for (const q of queries) {
        const { text, params } = q.__pg ?? q;
        out.push((await client.query(text, params ?? [])).rows);
      }
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  return f;
}

export const newPool = (url) => new pg.Pool({ connectionString: url, max: 4 });
