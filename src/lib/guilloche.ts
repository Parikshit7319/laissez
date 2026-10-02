// Guilloche generators: the fine-line interference patterns used on share
// certificates, passports and banknotes. Pure functions, used at build time
// and in the browser.

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

const f = (n: number) => n.toFixed(2);

/** One hypotrochoid curve as an SVG path, centred on (cx, cy). */
export function hypotrochoid(opts: {
  R: number; r: number; d: number; cx: number; cy: number; scale?: number; rotate?: number; steps?: number;
}): string {
  const { R, r, d, cx, cy, scale = 1, rotate = 0 } = opts;
  const turns = r / gcd(R, r);
  const total = Math.PI * 2 * turns;
  const steps = opts.steps ?? Math.round(360 * turns);
  const k = (R - r) / r;
  const cosR = Math.cos(rotate), sinR = Math.sin(rotate);
  let p = '';
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * total;
    const x0 = ((R - r) * Math.cos(t) + d * Math.cos(k * t)) * scale;
    const y0 = ((R - r) * Math.sin(t) - d * Math.sin(k * t)) * scale;
    const x = cx + x0 * cosR - y0 * sinR;
    const y = cy + x0 * sinR + y0 * cosR;
    p += (i === 0 ? 'M' : 'L') + f(x) + ' ' + f(y);
  }
  return p + 'Z';
}

/** A layered rosette: several hypotrochoids with offset rotation and depth. */
export function rosette(size: number, layers = 4, seed = 0): string[] {
  const c = size / 2;
  const out: string[] = [];
  const base = [
    { R: 120, r: 45, d: 60 },
    { R: 120, r: 50, d: 72 },
    { R: 120, r: 55, d: 38 },
    { R: 120, r: 35, d: 52 },
    { R: 120, r: 40, d: 80 },
  ];
  for (let i = 0; i < layers; i++) {
    const b = base[(i + seed) % base.length];
    const extent = b.R - b.r + b.d;
    out.push(
      hypotrochoid({ ...b, cx: c, cy: c, scale: (c * (0.98 - i * 0.06)) / extent, rotate: (i * Math.PI) / (layers * 3) })
    );
  }
  return out;
}

/** Braided horizontal band of phase-shifted sine waves. */
export function band(width: number, height: number, strands = 6, waves = 7): string[] {
  const out: string[] = [];
  const mid = height / 2;
  const amp = height * 0.42;
  const steps = Math.round(width / 2);
  for (let s = 0; s < strands; s++) {
    const phase = (s / strands) * Math.PI * 2;
    for (const sign of [1, -1]) {
      let p = '';
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * width;
        const y = mid + sign * amp * Math.sin((x / width) * Math.PI * 2 * waves + phase) * (0.75 + 0.25 * Math.cos((x / width) * Math.PI * 2 * 2 + phase));
        p += (i === 0 ? 'M' : 'L') + f(x) + ' ' + f(y);
      }
      out.push(p);
    }
  }
  return out;
}
