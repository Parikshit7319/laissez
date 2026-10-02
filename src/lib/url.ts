export const ARTIFACT = import.meta.env.PUBLIC_ARTIFACT === '1';
const raw = import.meta.env.BASE_URL || '/';
export const base = raw.endsWith('/') ? raw.slice(0, -1) : raw;
export const url = (p = '') => `${base}/${p.replace(/^\//, '')}`;
