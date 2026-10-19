// @ts-check
/**
 * Deterministic map generation.
 *
 * Pipeline:
 *   1. irregular convex outline (convex hull + Chaikin smoothing)
 *   2. Poisson-disk city sites inside the outline
 *   3. half-plane Voronoi cells (one per city), snapped to a 0.001 grid
 *   4. shared interior edges replaced by a single deterministic curve used by
 *      both neighbouring cells, so the tiling stays gap- and overlap-free
 *   5. adjacency graph + terrain + city names
 *
 * Same seed + options always produce the same map.
 */

import { createRng, deriveSeed } from './rng.js';
import {
  chaikin,
  clipPolygonHalfPlane,
  convexHull,
  distance,
  pointInPolygon,
  polygonArea,
  polygonBounds,
} from './geometry.js';

/** @typedef {[number, number]} Point */

/**
 * @typedef {Object} MapCity
 * @property {number} id
 * @property {string} name
 * @property {Point} center
 * @property {Point[]} polygon
 * @property {number[]} neighbors
 * @property {'plains' | 'forest' | 'hills' | 'mountain'} terrain
 * @property {number} area
 */

/**
 * @typedef {Object} GameMap
 * @property {number} seed
 * @property {number} width
 * @property {number} height
 * @property {Point[]} outline
 * @property {MapCity[]} cities
 * @property {{ cityCount: number, outlineArea: number, coverage: number }} meta
 */

export const TERRAINS = /** @type {const} */ ([
  'plains',
  'forest',
  'hills',
  'mountain',
]);

/** @type {Record<'plains' | 'forest' | 'hills' | 'mountain', string>} */
export const TERRAIN_LABELS = {
  plains: '平原',
  forest: '森林',
  hills: '丘陵',
  mountain: '山地',
};

export const MAP_DEFAULTS = Object.freeze({
  seed: 1,
  width: 2000,
  height: 1400,
  cityCount: 160,
});

const QUANT = 1000; // 0.001 world units

const CITY_PREFIX = [
  '临', '青', '白', '赤', '黑', '金', '石', '林', '风', '云',
  '雪', '松', '江', '河', '山', '海', '原', '野', '安', '平',
  '新', '古', '北', '南', '东', '西', '高', '长', '大', '小',
];

const CITY_SUFFIX = [
  '川', '原', '城', '关', '州', '郡', '谷', '丘', '岭', '渡',
  '门', '津', '陵', '泽', '野', '阳', '阴', '安', '平', '兴',
  '盛', '远', '宁', '定', '和', '顺', '昌', '隆', '泰', '康',
];

/**
 * Snap to the shared grid so independently clipped cells agree on vertices.
 * @param {Point} point
 * @returns {Point}
 */
function quantize(point) {
  return [Math.round(point[0] * QUANT) / QUANT, Math.round(point[1] * QUANT) / QUANT];
}

/**
 * @param {Point} point
 * @returns {string}
 */
function pointKey(point) {
  return `${Math.round(point[0] * QUANT)},${Math.round(point[1] * QUANT)}`;
}

/**
 * @param {Point} a
 * @param {Point} b
 * @returns {string}
 */
function edgeKey(a, b) {
  const ka = pointKey(a);
  const kb = pointKey(b);
  return ka <= kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/**
 * Remove consecutive duplicates and an explicit closing point.
 * @param {Point[]} polygon
 * @returns {Point[]}
 */
function normalizePolygon(polygon) {
  /** @type {Point[]} */
  const points = [];
  for (const raw of polygon) {
    const point = quantize(raw);
    const last = points[points.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) points.push(point);
  }
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) points.pop();
  }
  return points;
}

/**
 * Irregular convex continent outline.
 * @param {import('./rng.js').Rng} rng
 * @param {number} width
 * @param {number} height
 * @returns {Point[]}
 */
function generateOutline(rng, width, height) {
  const centerX = width / 2;
  const centerY = height / 2;
  const vertices = 18 + rng.int(0, 8);
  const phase = rng.range(0, Math.PI * 2);
  /** @type {Point[]} */
  const raw = [];
  for (let i = 0; i < vertices; i += 1) {
    const angle = (i / vertices) * Math.PI * 2;
    const wobble =
      1 +
      0.06 * Math.sin(angle * 3 + phase) +
      0.04 * Math.sin(angle * 5 - phase * 1.7) +
      rng.range(-0.03, 0.03);
    raw.push([
      centerX + Math.cos(angle) * width * 0.4 * wobble,
      centerY + Math.sin(angle) * height * 0.4 * wobble,
    ]);
  }
  return chaikin(convexHull(raw), 2).map(quantize);
}

/**
 * Poisson-disk sampling with adaptive radius so exactly `count` sites fit.
 * @param {import('./rng.js').Rng} rng
 * @param {Point[]} outline
 * @param {number} count
 * @returns {Point[]}
 */
function sampleCitySites(rng, outline, count) {
  const bounds = polygonBounds(outline);
  const area = Math.abs(polygonArea(outline));
  let radius = Math.sqrt(area / count) * 0.92;
  /** @type {Point[]} */
  let sites = [];

  for (let attempt = 0; attempt < 16 && sites.length < count; attempt += 1) {
    sites = [];
    const radiusSquared = radius * radius;
    const maxAttempts = count * 60;
    for (let i = 0; i < maxAttempts && sites.length < count; i += 1) {
      const point = /** @type {Point} */ ([
        rng.range(bounds.minX, bounds.maxX),
        rng.range(bounds.minY, bounds.maxY),
      ]);
      if (!pointInPolygon(point, outline)) continue;

      let valid = true;
      for (let k = 0; k < sites.length; k += 1) {
        const dx = sites[k][0] - point[0];
        const dy = sites[k][1] - point[1];
        if (dx * dx + dy * dy < radiusSquared) {
          valid = false;
          break;
        }
      }
      if (valid) sites.push(point);
    }
    if (sites.length < count) radius *= 0.92;
  }

  if (sites.length < count) {
    throw new Error(`Unable to place ${count} cities inside the outline`);
  }
  return sites.map(quantize);
}

/**
 * One Voronoi cell per site through successive half-plane clipping.
 * @param {Point[]} sites
 * @param {Point[]} outline
 * @returns {Point[][]}
 */
function buildCells(sites, outline) {
  /** @type {Point[][]} */
  const cells = [];
  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i];
    let polygon = outline;
    for (let j = 0; j < sites.length && polygon.length >= 3; j += 1) {
      if (i === j) continue;
      const other = sites[j];
      const nx = other[0] - site[0];
      const ny = other[1] - site[1];
      const offset =
        ((site[0] + other[0]) / 2) * nx + ((site[1] + other[1]) / 2) * ny;
      polygon = clipPolygonHalfPlane(polygon, nx, ny, offset);
    }
    const normalized = normalizePolygon(polygon);
    if (normalized.length < 3) {
      throw new Error(`City ${i} ended up without a territory`);
    }
    cells.push(normalized);
  }
  return cells;
}

/**
 * Adjacency from shared vertices (two shared vertices == shared edge).
 * Also counts how many cells use every edge so boundary edges can stay straight.
 * @param {Point[][]} cells
 * @returns {{ neighbors: number[][], edgeUsage: Map<string, number> }}
 */
function buildTopology(cells) {
  /** @type {Map<string, number>} */
  const edgeUsage = new Map();
  const keySets = cells.map((cell) => {
    const keys = new Set(cell.map(pointKey));
    for (let i = 0; i < cell.length; i += 1) {
      const key = edgeKey(cell[i], cell[(i + 1) % cell.length]);
      edgeUsage.set(key, (edgeUsage.get(key) ?? 0) + 1);
    }
    return keys;
  });

  const neighbors = cells.map(() => new Set());
  for (let i = 0; i < cells.length; i += 1) {
    for (let j = i + 1; j < cells.length; j += 1) {
      let shared = 0;
      for (const key of keySets[i]) {
        if (keySets[j].has(key)) {
          shared += 1;
          if (shared >= 2) break;
        }
      }
      if (shared >= 2) {
        neighbors[i].add(j);
        neighbors[j].add(i);
      }
    }
  }

  return {
    neighbors: neighbors.map((set) => [...set].sort((a, b) => a - b)),
    edgeUsage,
  };
}

/**
 * Replace every shared edge with one jittered curve used by both neighbours.
 * Boundary edges (used by a single cell) stay straight so the continent
 * outline remains exact.
 * @param {Point[][]} cells
 * @param {Map<string, number>} edgeUsage
 * @param {number | string} seed
 * @returns {Point[][]}
 */
function jitterCells(cells, edgeUsage, seed) {
  /** @type {Map<string, Point[]>} */
  const curves = new Map();

  /**
   * @param {Point} a
   * @param {Point} b
   * @returns {{ interior: Point[], forward: boolean } | null}
   */
  function curveFor(a, b) {
    const key = edgeKey(a, b);
    if ((edgeUsage.get(key) ?? 0) < 2) return null;

    const ka = pointKey(a);
    const kb = pointKey(b);
    const forward = ka <= kb;
    const ordered = forward ? `${ka}|${kb}` : `${kb}|${ka}`;
    let interior = curves.get(ordered);

    if (!interior) {
      const rng = createRng(deriveSeed(seed, `edge:${ordered}`));
      const first = forward ? a : b;
      const second = forward ? b : a;
      const length = distance(first, second) || 1;
      const nx = -(second[1] - first[1]) / length;
      const ny = (second[0] - first[0]) / length;
      const amplitude = Math.min(24, length * 0.25);

      interior = [];
      for (let step = 1; step <= 4; step += 1) {
        const t = step / 5;
        const offset = rng.range(-1, 1) * amplitude * Math.sin(Math.PI * t);
        interior.push([
          first[0] + (second[0] - first[0]) * t + nx * offset,
          first[1] + (second[1] - first[1]) * t + ny * offset,
        ]);
      }
      curves.set(ordered, interior);
    }

    return { interior, forward };
  }

  return cells.map((cell) => {
    /** @type {Point[]} */
    const polygon = [];
    for (let i = 0; i < cell.length; i += 1) {
      const a = cell[i];
      const b = cell[(i + 1) % cell.length];
      polygon.push(a);
      const curve = curveFor(a, b);
      if (!curve) continue;
      if (curve.forward) {
        polygon.push(...curve.interior);
      } else {
        for (let k = curve.interior.length - 1; k >= 0; k -= 1) {
          polygon.push(curve.interior[k]);
        }
      }
    }
    return polygon;
  });
}

/**
 * Smooth 2D value noise in [0, 1).
 * @param {number} seed
 * @returns {(u: number, v: number) => number}
 */
function createValueNoise(seed) {
  const rng = createRng(seed);
  const size = 32;
  const values = new Float64Array(size * size);
  for (let i = 0; i < values.length; i += 1) values[i] = rng.next();

  /** @param {number} index */
  const wrap = (index) => ((index % size) + size) % size;
  /** @param {number} ix @param {number} iy */
  const at = (ix, iy) => values[wrap(iy) * size + wrap(ix)];
  /** @param {number} t */
  const smooth = (t) => t * t * (3 - 2 * t);

  return (u, v) => {
    const x = u * size;
    const y = v * size;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = smooth(x - x0);
    const ty = smooth(y - y0);
    const v00 = at(x0, y0);
    const v10 = at(x0 + 1, y0);
    const v01 = at(x0, y0 + 1);
    const v11 = at(x0 + 1, y0 + 1);
    return (
      (v00 * (1 - tx) + v10 * tx) * (1 - ty) +
      (v01 * (1 - tx) + v11 * tx) * ty
    );
  };
}

/**
 * @param {Point[]} centers
 * @param {number} width
 * @param {number} height
 * @param {number | string} seed
 * @returns {Array<'plains' | 'forest' | 'hills' | 'mountain'>}
 */
function assignTerrains(centers, width, height, seed) {
  const noise = createValueNoise(deriveSeed(seed, 'terrain'));
  return centers.map(([x, y]) => {
    const value = noise(x / width, y / height);
    if (value < 0.52) return 'plains';
    if (value < 0.74) return 'forest';
    if (value < 0.9) return 'hills';
    return 'mountain';
  });
}

/**
 * @param {import('./rng.js').Rng} rng
 * @param {number} count
 * @returns {string[]}
 */
function generateNames(rng, count) {
  /** @type {string[]} */
  const names = [];
  const used = new Set();
  for (let i = 0; i < count; i += 1) {
    let name = rng.pick(CITY_PREFIX) + rng.pick(CITY_SUFFIX);
    let guard = 0;
    while (used.has(name) && guard < 200) {
      name = rng.pick(CITY_PREFIX) + rng.pick(CITY_SUFFIX);
      guard += 1;
    }
    if (used.has(name)) name = `${name}${i + 1}`;
    used.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Generate a complete, deterministic map.
 * @param {{ seed?: number | string, width?: number, height?: number, cityCount?: number }} [options]
 * @returns {GameMap}
 */
export function generateMap(options = {}) {
  const seed = options.seed ?? MAP_DEFAULTS.seed;
  const width = options.width ?? MAP_DEFAULTS.width;
  const height = options.height ?? MAP_DEFAULTS.height;
  const cityCount = options.cityCount ?? MAP_DEFAULTS.cityCount;

  if (!(width > 0) || !(height > 0)) {
    throw new RangeError('width and height must be positive');
  }
  if (!Number.isInteger(cityCount) || cityCount < 1) {
    throw new RangeError('cityCount must be a positive integer');
  }

  const outline = generateOutline(createRng(deriveSeed(seed, 'outline')), width, height);
  const centers = sampleCitySites(
    createRng(deriveSeed(seed, 'sites')),
    outline,
    cityCount,
  );
  const cells = buildCells(centers, outline);
  const { neighbors, edgeUsage } = buildTopology(cells);
  const polygons = jitterCells(cells, edgeUsage, seed);
  const names = generateNames(createRng(deriveSeed(seed, 'names')), centers.length);
  const terrains = assignTerrains(centers, width, height, seed);

  let areaSum = 0;
  /** @type {MapCity[]} */
  const cities = polygons.map((polygon, index) => {
    const area = Math.abs(polygonArea(polygon));
    areaSum += area;
    return {
      id: index,
      name: names[index],
      center: centers[index],
      polygon,
      neighbors: neighbors[index],
      terrain: terrains[index],
      area,
    };
  });

  const outlineArea = Math.abs(polygonArea(outline));

  return {
    seed,
    width,
    height,
    outline,
    cities,
    meta: {
      cityCount: cities.length,
      outlineArea,
      coverage: areaSum / outlineArea,
    },
  };
}
