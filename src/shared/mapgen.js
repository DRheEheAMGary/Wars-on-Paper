// @ts-check
/**
 * Deterministic map generation.
 *
 * Pipeline:
 *   1. large rectangular world with a thin ocean margin
 *   2. jittered-lattice candidate sites inside the inset rectangle
 *   3. power-diagram cells (random per-city weights) for every candidate site
 *   4. a star-shaped land field (anisotropic + harmonic coastline) plus radial
 *      ocean corridors: taking the cells with the smallest field value and
 *      skipping corridor cells yields exactly `cityCount` land cells split into
 *      several connected continents. A star-shaped region minus radial cuts has
 *      no lakes, so the map never contains enclosed water.
 *   5. shared interior edges are replaced by one deterministic curve used by
 *      both neighbours, then a smooth domain warp deforms shapes
 *   6. adjacency graph (within a continent) + terrain + English city names
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
 * @property {number} continent
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
 *   continentCount: number,
 *   continentSizes: number[],
 *   lakeCount: number,
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

/** Share of candidate cells that becomes land (the rest is ocean). */
const LAND_CANDIDATE_FRACTION_MIN = 0.7;
const LAND_CANDIDATE_FRACTION_MAX = 0.78;

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
 * Voronoi cells.
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
 * @param {Point[][]} cells
 * @returns {number[][]}
 */
function buildTopology(cells) {
  const keySets = cells.map((cell) => new Set(cell.map(pointKey)));

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

  return neighbors.map((set) => [...set].sort((a, b) => a - b));
}

/**
 * Replace every edge — including the outer map boundary — with one jittered
 * curve used by both neighbours when there is one. This keeps the tiling exact
 * and prevents perfectly straight coastlines.
 * @param {Point[][]} cells
 * @param {number | string} seed
 * @returns {Point[][]}
 */
function jitterCells(cells, seed) {
  /** @type {Map<string, Point[]>} */
  const curves = new Map();

  /**
   * @param {Point} a
   * @param {Point} b
   * @returns {{ interior: Point[], forward: boolean }}
   */
  function curveFor(a, b) {
    const key = edgeKey(a, b);
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
 * warped identically, so the tiling stays exact.
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
 * Number of continents for a given map size.
 * @param {number} cityCount
 * @returns {number}
 */
function continentCountFor(cityCount) {
  if (cityCount < 12) return 1;
  if (cityCount >= 300) return 4;
  if (cityCount >= 120) return 3;
  return 2;
}

/**
 * Anisotropic, harmonic "star field" with coastline noise: a smooth radial
 * function around a random centre. Taking cells with the smallest value gives a
 * star-shaped, hole-free land region with an irregular coast.
 * @param {import('./rng.js').Rng} rng
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} bounds
 * @param {(u: number, v: number) => number} noise Smooth noise in [0, 1).
 * @returns {{ center: Point, value: (x: number, y: number) => number }}
 */
function createStarField(rng, bounds, noise) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const centerX = bounds.minX + width * (0.25 + 0.5 * rng.next());
  const centerY = bounds.minY + height * (0.25 + 0.5 * rng.next());
  const rotation = rng.range(0, Math.PI * 2);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const scaleX = rng.range(0.72, 1.28);
  const scaleY = rng.range(0.72, 1.28);
  const normScale = Math.min(width, height) * 0.5;
  const coastNoiseWeight = rng.range(0.1, 0.18);
  const coastFrequency = rng.range(1.7, 2.6);
  const detailFrequency = coastFrequency * rng.range(2.0, 2.8);

  /** @type {{ harmonic: number, amplitude: number, phase: number }[]} */
  const harmonics = [];
  for (let harmonic = 2; harmonic <= 7; harmonic += 1) {
    harmonics.push({
      harmonic,
      amplitude: rng.range(0.018, 0.07),
      phase: rng.range(0, Math.PI * 2),
    });
  }

  return {
    center: [centerX, centerY],
    value(x, y) {
      const dx = x - centerX;
      const dy = y - centerY;
      const localX = (dx * cos + dy * sin) / scaleX;
      const localY = (-dx * sin + dy * cos) / scaleY;
      const radius = Math.hypot(localX, localY);
      const angle = Math.atan2(localY, localX);
      let shape = 1;
      for (const term of harmonics) {
        shape += term.amplitude * Math.sin(term.harmonic * angle + term.phase);
      }
      shape = Math.max(0.6, shape);

      const u = (x - bounds.minX) / width;
      const v = (y - bounds.minY) / height;
      const coast =
        noise(u * coastFrequency, v * coastFrequency) * 0.65 +
        noise(u * detailFrequency + 0.37, v * detailFrequency + 0.61) * 0.35;

      return radius / shape / normScale + (coast - 0.5) * coastNoiseWeight;
    },
  };
}

/**
 * Build one connected corridor of cells per angle, marching from the star
 * centre to the map edge along the candidate adjacency graph. Thin cell chains
 * guarantee that the star-shaped land is cut into separate continents.
 * @param {Point[]} sites
 * @param {number[][]} neighbors
 * @param {Point} center
 * @param {number[]} angles
 * @returns {Set<number>}
 */
function buildCorridorPaths(sites, neighbors, center, angles) {
  let central = 0;
  let bestDistance = Infinity;
  for (let id = 0; id < sites.length; id += 1) {
    const d = Math.hypot(sites[id][0] - center[0], sites[id][1] - center[1]);
    if (d < bestDistance) {
      bestDistance = d;
      central = id;
    }
  }

  const corridors = new Set([central]);

  for (const angle of angles) {
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    let current = central;
    let currentProjection = 0;
    const visited = new Set([central]);

    for (let step = 0; step < 1024; step += 1) {
      let nextId = -1;
      let nextProjection = -Infinity;
      for (const neighbour of neighbors[current]) {
        if (visited.has(neighbour)) continue;
        const projection =
          (sites[neighbour][0] - center[0]) * dirX +
          (sites[neighbour][1] - center[1]) * dirY;
        if (projection > nextProjection) {
          nextProjection = projection;
          nextId = neighbour;
        }
      }
      if (nextId < 0 || nextProjection <= currentProjection) break;
      visited.add(nextId);
      corridors.add(nextId);
      current = nextId;
      currentProjection = nextProjection;
    }
  }

  return corridors;
}

/**
 * Grow a corridor set by a number of cell rings.
 * @param {Set<number>} corridor
 * @param {number[][]} neighbors
 * @param {number} rings
 * @returns {Set<number>}
 */
function expandCorridor(corridor, neighbors, rings) {
  let current = new Set(corridor);
  for (let ring = 0; ring < rings; ring += 1) {
    const next = new Set(current);
    for (const id of current) {
      for (const neighbour of neighbors[id]) next.add(neighbour);
    }
    current = next;
  }
  return current;
}

/**
 * Connected components of a land set using the candidate adjacency graph.
 * @param {Set<number>} land
 * @param {number[][]} neighbors
 * @returns {{ components: number[][], continentOf: Map<number, number> }}
 */
function findComponents(land, neighbors) {
  /** @type {Map<number, number>} */
  const continentOf = new Map();
  /** @type {number[][]} */
  const components = [];

  for (const start of land) {
    if (continentOf.has(start)) continue;
    const continentIndex = components.length;
    /** @type {number[]} */
    const component = [];
    const stack = [start];
    continentOf.set(start, continentIndex);
    while (stack.length > 0) {
      const id = /** @type {number} */ (stack.pop());
      component.push(id);
      for (const neighbour of neighbors[id]) {
        if (!land.has(neighbour) || continentOf.has(neighbour)) continue;
        continentOf.set(neighbour, continentIndex);
        stack.push(neighbour);
      }
    }
    components.push(component);
  }

  return { components, continentOf };
}

/**
 * Pick a cell that can be removed from the land while keeping its continent
 * connected. Prefers coastal cells with the largest field value.
 * @param {Set<number>} land
 * @param {number[][]} neighbors
 * @param {Map<number, number>} continentOf
 * @param {number[]} orderByValueDesc
 * @param {Map<number, number>} continentSizes
 * @param {Set<number>} protectedCells Cells that must not be removed.
 * @param {Set<number>} borderCells Cells that touch the outer ocean; removing
 *   them can never create an enclosed lake.
 * @returns {number | null}
 */
function findRemovableCell(
  land,
  neighbors,
  continentOf,
  orderByValueDesc,
  continentSizes,
  protectedCells,
  borderCells,
) {
  for (const id of orderByValueDesc) {
    if (!land.has(id) || protectedCells.has(id)) continue;
    const continent = continentOf.get(id);
    if (continent === undefined) continue;
    if ((continentSizes.get(continent) ?? 0) <= 1) continue;

    let landNeighbours = 0;
    let oceanNeighbours = 0;
    for (const neighbour of neighbors[id]) {
      if (land.has(neighbour)) landNeighbours += 1;
      else oceanNeighbours += 1;
    }
    // Removing an interior cell without any ocean neighbour would create a
    // brand-new enclosed lake; only coastal cells are safe in that sense.
    if (!borderCells.has(id) && oceanNeighbours === 0) continue;
    if (landNeighbours <= 1) return id;

    // Non-leaf cell: only remove it if its continent stays connected.
    land.delete(id);
    const size = continentSizes.get(continent) ?? 0;
    const seen = new Set();
    const stack = [];
    for (const neighbour of neighbors[id]) {
      if (land.has(neighbour) && continentOf.get(neighbour) === continent) {
        stack.push(neighbour);
        break;
      }
    }
    const first = stack[0];
    if (first !== undefined) {
      seen.add(first);
      while (stack.length > 0) {
        const current = /** @type {number} */ (stack.pop());
        for (const neighbour of neighbors[current]) {
          if (
            land.has(neighbour) &&
            continentOf.get(neighbour) === continent &&
            !seen.has(neighbour)
          ) {
            seen.add(neighbour);
            stack.push(neighbour);
          }
        }
      }
    }
    land.add(id);
    if (seen.size === size - 1) return id;
  }
  return null;
}

/**
 * Remove enclosed water cells ("lakes"). New land cells are added first, then
 * an equal number of removable cells is taken away, keeping the city count.
 * @param {Set<number>} land
 * @param {number[][]} neighbors
 * @param {Map<number, number>} continentOf
 * @param {Set<number>} corridors
 * @param {number[]} orderByValueDesc
 * @param {number} siteCount
 * @param {Set<number>} borderCells
 * @returns {number} Remaining lake count (should be 0).
 */
function removeLakes(
  land,
  neighbors,
  continentOf,
  corridors,
  orderByValueDesc,
  siteCount,
  borderCells,
) {
  const targetSize = land.size;

  /** @type {number[]} */
  const lakes = [];
  for (let id = 0; id < siteCount; id += 1) {
    if (land.has(id) || corridors.has(id) || borderCells.has(id)) continue;
    const adjacent = neighbors[id];
    if (adjacent.length === 0) continue;
    if (adjacent.every((neighbour) => land.has(neighbour))) lakes.push(id);
  }
  if (lakes.length === 0) return 0;

  const protectedCells = new Set(lakes);
  for (const lakeId of lakes) {
    land.add(lakeId);
    let assigned = false;
    for (const neighbour of neighbors[lakeId]) {
      if (!land.has(neighbour)) continue;
      const continent = continentOf.get(neighbour);
      if (continent === undefined) continue;
      continentOf.set(lakeId, continent);
      assigned = true;
      break;
    }
    if (!assigned) continentOf.delete(lakeId);
  }

  /** @type {Map<number, number>} */
  const continentSizes = new Map();
  for (const id of land) {
    const continent = continentOf.get(id) ?? 0;
    continentSizes.set(continent, (continentSizes.get(continent) ?? 0) + 1);
  }

  while (land.size > targetSize) {
    const victim = findRemovableCell(
      land,
      neighbors,
      continentOf,
      orderByValueDesc,
      continentSizes,
      protectedCells,
      borderCells,
    );
    if (victim === null) break;
    const continent = continentOf.get(victim);
    land.delete(victim);
    continentOf.delete(victim);
    if (continent !== undefined) {
      continentSizes.set(continent, (continentSizes.get(continent) ?? 1) - 1);
    }
  }

  // Report any enclosed water cell that still has land on every side.
  let remaining = 0;
  for (let id = 0; id < siteCount; id += 1) {
    if (land.has(id) || corridors.has(id) || borderCells.has(id)) continue;
    const adjacent = neighbors[id];
    if (adjacent.length > 0 && adjacent.every((neighbour) => land.has(neighbour))) {
      remaining += 1;
    }
  }
  return remaining;
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
  const width = options.width ?? 2450 + dimensionRng.int(0, 350);
  const height = options.height ?? 1450 + dimensionRng.int(0, 350);
  if (!(width > 0) || !(height > 0)) {
    throw new RangeError('width and height must be positive');
  }

  const layoutRng = createRng(deriveSeed(seed, 'layout'));
  const landCandidateFraction = layoutRng.range(
    LAND_CANDIDATE_FRACTION_MIN,
    LAND_CANDIDATE_FRACTION_MAX,
  );
  const continentTarget = continentCountFor(cityCount);
  const candidateCount = Math.max(
    cityCount + continentTarget,
    Math.ceil(cityCount / landCandidateFraction),
  );

  const margin = Math.round(Math.min(width, height) * 0.06);
  const inset = rectanglePolygon(margin, margin, width - margin, height - margin);
  const insetBounds = polygonBounds(inset);
  const insetArea = Math.abs(polygonArea(inset));

  const sites = sampleSites(
    createRng(deriveSeed(seed, 'sites')),
    insetBounds,
    candidateCount,
  );

  const meanCellArea = insetArea / candidateCount;

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

  const neighbors = buildTopology(cells);

  // Cells that touch the inset rectangle are open to the outer ocean margin;
  // they are never "lakes" and are safe to remove without enclosing water.
  const borderEpsilon = margin + 0.6;
  /** @type {Set<number>} */
  const borderCells = new Set();
  cells.forEach((cell, id) => {
    const bounds = polygonBounds(cell);
    if (
      bounds.minX <= borderEpsilon ||
      bounds.maxX >= width - borderEpsilon ||
      bounds.minY <= borderEpsilon ||
      bounds.maxY >= height - borderEpsilon
    ) {
      borderCells.add(id);
    }
  });

  const coastNoise = createValueNoise(deriveSeed(seed, 'coast'));
  const star = createStarField(layoutRng, insetBounds, coastNoise);
  const fieldValues = sites.map(([x, y]) => star.value(x, y));
  const orderByValue = sites
    .map((_, id) => id)
    .sort((a, b) => fieldValues[a] - fieldValues[b]);
  const orderByValueDesc = orderByValue.slice().reverse();

  const baseAngle = layoutRng.range(0, Math.PI * 2);

  /**
   * @param {number} angle
   * @returns {number[]}
   */
  function corridorAnglesFor(angle) {
    if (continentTarget <= 1) return [];
    /** @type {number[]} */
    const angles = [];
    for (let i = 0; i < continentTarget; i += 1) {
      angles.push(angle + (i * Math.PI * 2) / continentTarget);
    }
    return angles;
  }

  /** @type {{ land: Set<number>, corridors: Set<number>, continentOf: Map<number, number>, components: number[][] } | null} */
  let layout = null;
  let bestScore = -Infinity;

  // Rotate the corridor layout and retry until every continent has a usable
  // size; this avoids single-cell islands and disconnected slivers.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let corridors;
    if (continentTarget <= 1) {
      corridors = new Set();
    } else {
      const angle = baseAngle + attempt * (Math.PI / 6);
      corridors = buildCorridorPaths(
        sites,
        neighbors,
        star.center,
        corridorAnglesFor(angle),
      );
      const rings = attempt % 3;
      if (rings > 0) corridors = expandCorridor(corridors, neighbors, rings);
    }

    /** @type {Set<number>} */
    const land = new Set();
    for (const id of orderByValue) {
      if (corridors.has(id)) continue;
      land.add(id);
      if (land.size >= cityCount) break;
    }
    if (land.size < cityCount) continue;

    const { components, continentOf } = findComponents(land, neighbors);
    const minSize = components.reduce(
      (smallest, component) => Math.min(smallest, component.length),
      Infinity,
    );
    const score =
      (components.length >= 2 ? 1000 : 0) +
      Math.min(components.length, 6) * 100 +
      Math.min(minSize, 20) * 10;

    if (score > bestScore) {
      bestScore = score;
      layout = { land, corridors, continentOf, components };
    }
    if (continentTarget <= 1) break;
    if (components.length >= Math.min(continentTarget, 3) && minSize >= 3) break;
  }

  if (!layout) throw new Error('Failed to build the continent layout');

  const lakeCount = removeLakes(
    layout.land,
    neighbors,
    layout.continentOf,
    layout.corridors,
    orderByValueDesc,
    candidateCount,
    borderCells,
  );

  const refreshed = findComponents(layout.land, neighbors);
  /** @type {Map<number, number>} */
  const continentSizesById = new Map();
  for (const id of layout.land) {
    const continent = refreshed.continentOf.get(id) ?? 0;
    continentSizesById.set(continent, (continentSizesById.get(continent) ?? 0) + 1);
  }

  const basePolygons = jitterCells(cells, seed);
  const landIdList = [...layout.land].sort((a, b) => a - b);
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
      continent: refreshed.continentOf.get(oldId) ?? 0,
      area,
    };
  });

  const worldArea = width * height;
  const continentSizes = [...continentSizesById.values()].sort((a, b) => b - a);

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
      continentCount: continentSizes.length,
      continentSizes,
      lakeCount,
    },
  };
}
