// @ts-check
/**
 * Deterministic map generation.
 *
 * Pipeline:
 *   1. rectangular world with an ocean margin
 *   2. jittered-lattice candidate sites inside the inset rectangle
 *   3. power-diagram cells (random per-city weights) for every candidate site
 *   4. a connected land region is grown from the centre: exactly `cityCount`
 *      cells become city territories, every other cell becomes ocean — the
 *      continent edge is therefore made directly of city-territory edges
 *   5. shared interior edges are replaced by one deterministic curve used by
 *      both neighbours, then a smooth domain warp deforms shapes
 *   6. adjacency graph (land only) + terrain + English city names
 *
 * Same seed + options always produce the same map.
 */

import { createRng, deriveSeed } from './rng.js';
import {
  clipPolygonHalfPlane,
  distance,
  polygonArea,
  polygonBounds,
  polygonInteriorPoint,
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
 * @property {MapCity[]} cities
 * @property {{
 *   cityCount: number,
 *   candidateCount: number,
 *   landArea: number,
 *   worldArea: number,
 *   landAreaFraction: number,
 * }} meta
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

/** Target fraction of candidate cells that become land (the rest is ocean). */
const LAND_FRACTION_MIN = 0.52;
const LAND_FRACTION_MAX = 0.64;

const QUANT = 1000; // 0.001 world units

const CITY_PREFIX = [
  'Ash', 'Black', 'Bright', 'Broken', 'Clear', 'Cold', 'Copper', 'Dark', 'Dawn', 'Deep',
  'Dusk', 'East', 'Elm', 'Fair', 'Fallen', 'Far', 'Frost', 'Gold', 'Gray', 'Green',
  'Grim', 'High', 'Hollow', 'Iron', 'King', 'Lake', 'Long', 'Lost', 'Low', 'Mist',
  'Moon', 'Moss', 'New', 'North', 'Oak', 'Old', 'Pine', 'Red', 'River', 'Silver',
  'South', 'Star', 'Stone', 'Storm', 'Sun', 'Thorn', 'West', 'White', 'Wild', 'Wolf',
];

const CITY_SUFFIX = [
  'brook', 'crest', 'dale', 'field', 'ford', 'gate', 'glen', 'haven', 'hill', 'hold',
  'keep', 'moor', 'mouth', 'port', 'reach', 'rest', 'ridge', 'rock', 'run', 'shore',
  'side', 'stead', 'stone', 'vale', 'watch', 'well', 'wick', 'wood',
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
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @returns {Point[]}
 */
function rectanglePolygon(x0, y0, x1, y1) {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/**
 * Jittered lattice sampling. Deterministic, fast, and evenly spread enough for
 * Voronoi cells; randomness comes from the jitter and the shuffle.
 * @param {import('./rng.js').Rng} rng
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} bounds
 * @param {number} count
 * @returns {Point[]}
 */
function sampleSites(rng, bounds, count) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const spacing = Math.sqrt((width * height) / count);
  const columns = Math.max(1, Math.round(width / spacing));
  const rows = Math.max(1, Math.round(height / spacing));

  /** @type {Point[]} */
  const points = [];
  const stepX = width / columns;
  const stepY = height / rows;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      points.push([
        bounds.minX + (column + 0.5) * stepX + rng.range(-0.42, 0.42) * stepX,
        bounds.minY + (row + 0.5) * stepY + rng.range(-0.42, 0.42) * stepY,
      ]);
    }
  }

  const shuffled = rng.shuffle(points);
  if (shuffled.length < count) {
    while (shuffled.length < count) {
      shuffled.push([
        rng.range(bounds.minX, bounds.maxX),
        rng.range(bounds.minY, bounds.maxY),
      ]);
    }
  }
  return shuffled.slice(0, count).map(quantize);
}

/**
 * One power-diagram cell per site through successive half-plane clipping.
 * Random per-city weights change cell sizes, so territories are not uniformly
 * sized polygons.
 * @param {Point[]} sites
 * @param {Point[]} region
 * @param {number[]} weights Power weights (length² units).
 * @returns {Point[][]}
 */
function buildCells(sites, region, weights) {
  /** @type {Point[][]} */
  const cells = [];
  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i];
    let polygon = region;
    for (let j = 0; j < sites.length && polygon.length >= 3; j += 1) {
      if (i === j) continue;
      const other = sites[j];
      const nx = other[0] - site[0];
      const ny = other[1] - site[1];
      const offset =
        ((site[0] + other[0]) / 2) * nx +
        ((site[1] + other[1]) / 2) * ny +
        (weights[i] - weights[j]) / 2;
      polygon = clipPolygonHalfPlane(polygon, nx, ny, offset);
    }
    const normalized = normalizePolygon(polygon);
    if (normalized.length < 3) {
      throw new Error(`Cell ${i} ended up empty`);
    }
    cells.push(normalized);
  }
  return cells;
}

/**
 * Adjacency from shared vertices (two shared vertices == shared edge).
 * Also counts how many cells use every edge so region-boundary edges can stay
 * straight.
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
 * Edges on the outer rectangle stay straight.
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
      const amplitude = Math.min(36, length * 0.3);
      const style = rng.range(0.35, 1);
      const subdivisions = rng.int(3, 5);

      interior = [];
      for (let step = 1; step <= subdivisions; step += 1) {
        const t = step / (subdivisions + 1);
        const offset =
          rng.range(-1, 1) * amplitude * style * Math.sin(Math.PI * t);
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
 * Smooth domain warp applied to every polygon vertex. Shared vertices are
 * warped identically, so the tiling stays exact while shapes are locally
 * stretched or squashed.
 * @param {number | string} seed
 * @returns {(point: Point) => Point}
 */
function createWarp(seed) {
  const rng = createRng(deriveSeed(seed, 'warp'));
  const phaseA = rng.range(0, Math.PI * 2);
  const phaseB = rng.range(0, Math.PI * 2);
  const phaseC = rng.range(0, Math.PI * 2);
  const phaseD = rng.range(0, Math.PI * 2);
  const amplitudeX = rng.range(14, 26);
  const amplitudeY = rng.range(14, 26);
  const waveX = rng.range(420, 680);
  const waveY = rng.range(420, 680);

  return ([x, y]) => [
    x +
      amplitudeX *
        Math.sin((y / waveY) * Math.PI * 2 + phaseA) *
        Math.cos((x / waveX) * Math.PI * 2 + phaseB),
    y +
      amplitudeY *
        Math.sin((x / waveX) * Math.PI * 2 + phaseC) *
        Math.cos((y / waveY) * Math.PI * 2 + phaseD),
  ];
}

/**
 * Grow a connected land region of exactly `target` cells from the centre.
 * The coast is noisy rather than round: frontier picks are weighted by a value
 * noise field and a random drift direction, so continents vary per seed.
 * @param {Point[]} centers
 * @param {number[][]} neighbors
 * @param {number} target
 * @param {import('./rng.js').Rng} rng
 * @param {number | string} seed
 * @param {number} width
 * @param {number} height
 * @param {number} margin
 * @returns {Set<number>}
 */
function growLand(centers, neighbors, target, rng, seed, width, height, margin) {
  const centerX = width / 2;
  const centerY = height / 2;
  const noise = createValueNoise(deriveSeed(seed, 'coast'));
  const driftAngle = rng.range(0, Math.PI * 2);
  const driftX = Math.cos(driftAngle);
  const driftY = Math.sin(driftAngle);
  const halfDiagonal = Math.hypot(width, height) / 2;

  const centralRadius = Math.min(width, height) * 0.12;
  /** @type {{ id: number, d: number }[]} */
  const central = [];
  for (let i = 0; i < centers.length; i += 1) {
    const d = Math.hypot(centers[i][0] - centerX, centers[i][1] - centerY);
    if (d <= centralRadius) central.push({ id: i, d });
  }

  let startId = 0;
  if (central.length > 0) {
    central.sort((a, b) => a.d - b.d);
    const poolSize = Math.max(1, Math.ceil(central.length * 0.5));
    startId = central[rng.int(0, poolSize - 1)].id;
  }

  /** @type {Set<number>} */
  const land = new Set([startId]);
  /** @type {Set<number>} */
  const frontier = new Set(neighbors[startId]);

  const marginX = margin / width;
  const marginY = margin / height;

  while (land.size < target && frontier.size > 0) {
    const candidates = [...frontier];
    /** @type {number[]} */
    const weights = [];
    let total = 0;
    for (const id of candidates) {
      const [x, y] = centers[id];
      const u = Math.min(1, Math.max(0, (x / width - marginX) / (1 - 2 * marginX)));
      const v = Math.min(1, Math.max(0, (y / height - marginY) / (1 - 2 * marginY)));
      const noiseWeight = 0.55 + noise(u * 1.7, v * 1.7) * 1.4;
      const alignment =
        ((x - centerX) * driftX + (y - centerY) * driftY) / Math.max(1, halfDiagonal);
      const weight = Math.max(0.05, (1 + alignment * 1.1) * noiseWeight);
      weights.push(weight);
      total += weight;
    }

    let roll = rng.next() * total;
    let picked = candidates[candidates.length - 1];
    for (let i = 0; i < candidates.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) {
        picked = candidates[i];
        break;
      }
    }

    land.add(picked);
    frontier.delete(picked);
    for (const neighbour of neighbors[picked]) {
      if (!land.has(neighbour)) frontier.add(neighbour);
    }
  }

  if (land.size < target) {
    throw new Error(`Only grew ${land.size} of ${target} land cells`);
  }
  return land;
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
  const cityCount = options.cityCount ?? MAP_DEFAULTS.cityCount;

  if (!Number.isInteger(cityCount) || cityCount < 1) {
    throw new RangeError('cityCount must be a positive integer');
  }

  const dimensionRng = createRng(deriveSeed(seed, 'dimensions'));
  const width = options.width ?? 1900 + dimensionRng.int(0, 400);
  const height = options.height ?? 1150 + dimensionRng.int(0, 350);
  if (!(width > 0) || !(height > 0)) {
    throw new RangeError('width and height must be positive');
  }

  const landRng = createRng(deriveSeed(seed, 'land'));
  const landFraction = landRng.range(LAND_FRACTION_MIN, LAND_FRACTION_MAX);
  const candidateCount = Math.max(
    cityCount + 1,
    Math.ceil(cityCount / landFraction),
  );

  const margin = Math.round(Math.min(width, height) * 0.06);
  const inset = rectanglePolygon(margin, margin, width - margin, height - margin);
  const insetBounds = polygonBounds(inset);

  const sites = sampleSites(
    createRng(deriveSeed(seed, 'sites')),
    insetBounds,
    candidateCount,
  );

  const meanCellArea = Math.abs(polygonArea(inset)) / candidateCount;

  // Power weights make territory sizes varied, but very unlucky weight sets can
  // squeeze a cell away completely. Retry with weaker weights in that case.
  /** @type {Point[][] | null} */
  let cells = null;
  let weightAmplitude = 0.22;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const weightRng = createRng(deriveSeed(seed, `weights:${attempt}`));
    const weights = sites.map(
      () => weightRng.range(-weightAmplitude, weightAmplitude) * meanCellArea,
    );
    try {
      cells = buildCells(sites, inset, weights);
      break;
    } catch (error) {
      if (attempt === 5) throw error;
      weightAmplitude *= 0.55;
    }
  }
  if (!cells) throw new Error('Failed to build map cells');

  const { neighbors, edgeUsage } = buildTopology(cells);
  const basePolygons = jitterCells(cells, edgeUsage, seed);

  const landIds = growLand(
    sites,
    neighbors,
    cityCount,
    landRng,
    seed,
    width,
    height,
    margin,
  );
  const landIdList = [...landIds].sort((a, b) => a - b);
  /** @type {Map<number, number>} */
  const landIndex = new Map();
  landIdList.forEach((oldId, index) => landIndex.set(oldId, index));

  const warp = createWarp(seed);
  const polygons = landIdList.map((oldId) => basePolygons[oldId].map(warp));
  const warpedSites = landIdList.map((oldId) => warp(sites[oldId]));

  const names = generateNames(createRng(deriveSeed(seed, 'names')), landIdList.length);
  const terrains = assignTerrains(warpedSites, width, height, seed);

  let areaSum = 0;
  /** @type {MapCity[]} */
  const cities = polygons.map((polygon, index) => {
    const area = Math.abs(polygonArea(polygon));
    areaSum += area;

    const center = polygonInteriorPoint(polygon);

    const oldId = landIdList[index];
    /** @type {number[]} */
    const landNeighbors = [];
    for (const neighbourId of neighbors[oldId]) {
      const mapped = landIndex.get(neighbourId);
      if (mapped !== undefined) landNeighbors.push(mapped);
    }
    landNeighbors.sort((a, b) => a - b);

    return {
      id: index,
      name: names[index],
      center,
      polygon,
      neighbors: landNeighbors,
      terrain: terrains[index],
      area,
    };
  });

  const worldArea = width * height;

  return {
    seed,
    width,
    height,
    cities,
    meta: {
      cityCount: cities.length,
      candidateCount,
      landArea: areaSum,
      worldArea,
      landAreaFraction: areaSum / worldArea,
    },
  };
}
