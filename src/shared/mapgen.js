// @ts-check
/**
 * Deterministic map generation.
 *
 * Pipeline:
 *   1. large rectangular world with an ocean margin
 *   2. jittered-lattice candidate sites inside the inset rectangle
 *   3. power-diagram cells (random per-city weights) for every candidate site
 *   4. every continent is generated independently: its own random centre,
 *      anisotropic shape, coastline harmonics and noise. Cells are claimed in
 *      field order and never touch another continent, so the result looks like
 *      separate landmasses instead of sectors of one blob. The final world is
 *      enlarged until the ocean covers 70% of it.
 *   5. every edge (including the outer boundary) is replaced by one
 *      deterministic jitter curve shared by both neighbours
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
 *   islandCount: number,
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

/** Requested ocean share of the final rectangular world. */
const OCEAN_FRACTION = 0.7;

/**
 * The generation rectangle is larger than the old map so wide straits fit while
 * cell size (and therefore total land area) stays the same; the candidate count
 * scales with this area.
 */
const GENERATION_AREA_SCALE = 1.7;

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
 * curve used by both neighbours when there is one.
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
 * Independent continent shape: anisotropic radial field with strong low
 * harmonics (peninsulas) plus coastline noise. Small field values are inland.
 * @param {import('./rng.js').Rng} rng
 * @param {Point} center
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} bounds
 * @param {(u: number, v: number) => number} noise
 * @returns {{ center: Point, value: (x: number, y: number) => number }}
 */
function createContinentShape(rng, center, bounds, noise) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const rotation = rng.range(0, Math.PI * 2);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const scaleX = rng.range(0.55, 1.4);
  const scaleY = rng.range(0.55, 1.4);
  const normScale = Math.min(width, height) * 0.5;
  const coastWeight = rng.range(0.13, 0.22);
  const frequency = rng.range(1.5, 2.6);
  const offsetU = rng.range(0, 9);
  const offsetV = rng.range(0, 9);
  const offsetU2 = rng.range(0, 9);
  const offsetV2 = rng.range(0, 9);

  /** @type {{ harmonic: number, amplitude: number, phase: number }[]} */
  const harmonics = [];
  for (let harmonic = 2; harmonic <= 7; harmonic += 1) {
    const base = rng.range(0.035, 0.17) * (harmonic <= 3 ? 1 : 0.55);
    harmonics.push({
      harmonic,
      amplitude: Math.max(base, harmonic <= 3 ? 0.08 : 0.03),
      phase: rng.range(0, Math.PI * 2),
    });
  }

  return {
    center,
    value(x, y) {
      const dx = x - center[0];
      const dy = y - center[1];
      const localX = (dx * cos + dy * sin) / scaleX;
      const localY = (-dx * sin + dy * cos) / scaleY;
      const radius = Math.hypot(localX, localY);
      const angle = Math.atan2(localY, localX);
      let shape = 1;
      for (const term of harmonics) {
        shape += term.amplitude * Math.sin(term.harmonic * angle + term.phase);
      }
      shape = Math.max(0.5, shape);
      const u = (x - bounds.minX) / width;
      const v = (y - bounds.minY) / height;
      const coast =
        noise(u * frequency + offsetU, v * frequency + offsetV) * 0.62 +
        noise(u * frequency * 2.3 + offsetU2, v * frequency * 2.3 + offsetV2) * 0.38;
      return radius / shape / normScale + (coast - 0.5) * coastWeight;
    },
  };
}

/**
 * Spread continent centres across the map using farthest-point sampling.
 * @param {import('./rng.js').Rng} rng
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} bounds
 * @param {number} count
 * @returns {Point[]}
 */
function pickContinentCenters(rng, bounds, count) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const margin = 0.14;
  /** @type {Point[]} */
  const centers = [];

  for (let index = 0; index < count; index += 1) {
    /** @type {Point | null} */
    let best = null;
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const point = /** @type {Point} */ ([
        rng.range(bounds.minX + width * margin, bounds.maxX - width * margin),
        rng.range(bounds.minY + height * margin, bounds.maxY - height * margin),
      ]);
      let score;
      if (centers.length === 0) {
        score = rng.next();
      } else {
        let nearest = Infinity;
        for (const center of centers) {
          nearest = Math.min(
            nearest,
            Math.hypot(point[0] - center[0], point[1] - center[1]),
          );
        }
        score = nearest + rng.range(0, Math.min(width, height) * 0.05);
      }
      if (score > bestScore) {
        bestScore = score;
        best = point;
      }
    }
    centers.push(/** @type {Point} */ (best));
  }

  return centers;
}

/**
 * Random continent sizes, roughly proportional to per-continent weight.
 * @param {import('./rng.js').Rng} rng
 * @param {number} cityCount
 * @param {number} count
 * @returns {number[]}
 */
function allocateContinentSizes(rng, cityCount, count) {
  if (count === 1) return [cityCount];

  const weights = Array.from({ length: count }, () => rng.range(0.5, 1.4));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const sizes = weights.map((weight) =>
    Math.max(3, Math.floor((cityCount * weight) / total)),
  );

  let sum = sizes.reduce((accumulator, size) => accumulator + size, 0);
  let index = 0;
  while (sum < cityCount) {
    sizes[index % count] += 1;
    index += 1;
    sum += 1;
  }
  while (sum > cityCount) {
    if (sizes[index % count] > 3) {
      sizes[index % count] -= 1;
      sum -= 1;
    }
    index += 1;
  }
  return sizes;
}

/**
 * Claim `target` cells for one continent in field order. Cells next to another
 * continent are skipped, so continents never touch. Disconnected fragments are
 * released and the search continues, so the result stays connected.
 * @param {number[]} order Candidate ids sorted by field value.
 * @param {number} target
 * @param {Map<number, number>} owner Continent id per claimed cell.
 * @param {number[][]} neighbors
 * @param {number} continentIndex
 * @returns {Set<number> | null}
 */
function selectContinentCells(order, target, owner, neighbors, continentIndex) {
  /** @type {Set<number>} */
  const selected = new Set();
  let cursor = 0;
  let safety = 0;

  while (selected.size < target && safety < 50) {
    safety += 1;

    while (cursor < order.length && selected.size < target) {
      const id = order[cursor];
      cursor += 1;
      if (owner.has(id)) continue;

      let blocked = false;
      for (const neighbour of neighbors[id]) {
        const ownerId = owner.get(neighbour);
        if (ownerId !== undefined && ownerId !== continentIndex) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      selected.add(id);
      owner.set(id, continentIndex);
    }

    if (selected.size === 0) return null;

    // Keep only the largest connected component, then continue filling.
    const visited = new Set();
    /** @type {number[]} */
    let largest = [];
    for (const id of selected) {
      if (visited.has(id)) continue;
      /** @type {number[]} */
      const component = [];
      const stack = [id];
      visited.add(id);
      while (stack.length > 0) {
        const current = /** @type {number} */ (stack.pop());
        component.push(current);
        for (const neighbour of neighbors[current]) {
          if (selected.has(neighbour) && !visited.has(neighbour)) {
            visited.add(neighbour);
            stack.push(neighbour);
          }
        }
      }
      if (component.length > largest.length) largest = component;
    }

    if (largest.length < selected.size) {
      const keep = new Set(largest);
      for (const id of selected) {
        if (!keep.has(id)) {
          selected.delete(id);
          owner.delete(id);
        }
      }
    }
  }

  return selected.size >= target ? selected : null;
}

/**
 * Roughen a continent by peeling random coastal cells until it reaches
 * `target`. Removing land can never create a lake, and any removal that would
 * split the continent is rejected.
 * @param {Set<number>} selected
 * @param {number} target
 * @param {Map<number, number>} owner
 * @param {number[][]} neighbors
 * @param {number} continentIndex
 * @param {import('./rng.js').Rng} rng
 * @param {Set<number>} borderCells
 * @returns {Set<number>}
 */
function erodeContinent(
  selected,
  target,
  owner,
  neighbors,
  continentIndex,
  rng,
  borderCells,
) {
  let guard = 0;

  while (selected.size > target && guard < 400) {
    guard += 1;

    /** @type {number[]} */
    const boundary = [];
    for (const id of selected) {
      let isBoundary = borderCells.has(id);
      if (!isBoundary) {
        for (const neighbour of neighbors[id]) {
          if (!selected.has(neighbour)) {
            isBoundary = true;
            break;
          }
        }
      }
      if (isBoundary) boundary.push(id);
    }
    if (boundary.length === 0) break;

    let removed = false;
    for (const id of rng.shuffle(boundary)) {
      selected.delete(id);
      owner.delete(id);

      const first = selected.values().next();
      let connected = first.done === true;
      if (!first.done) {
        const seen = new Set([first.value]);
        const stack = [first.value];
        while (stack.length > 0) {
          const current = /** @type {number} */ (stack.pop());
          for (const neighbour of neighbors[current]) {
            if (selected.has(neighbour) && !seen.has(neighbour)) {
              seen.add(neighbour);
              stack.push(neighbour);
            }
          }
        }
        connected = seen.size === selected.size;
      }

      if (connected) {
        removed = true;
        break;
      }
      selected.add(id);
      owner.set(id, continentIndex);
    }

    if (!removed) break;
  }

  return selected;
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
 * connected and without creating a new enclosed lake.
 * @param {Set<number>} land
 * @param {number[][]} neighbors
 * @param {Map<number, number>} continentOf
 * @param {number[]} order
 * @param {Map<number, number>} continentSizes
 * @param {Set<number>} protectedCells
 * @param {Set<number>} borderCells
 * @param {number} keepAtLeast Minimum continent size to keep when removing.
 * @returns {number | null}
 */
function findRemovableCell(
  land,
  neighbors,
  continentOf,
  order,
  continentSizes,
  protectedCells,
  borderCells,
  keepAtLeast,
) {
  for (const id of order) {
    if (!land.has(id) || protectedCells.has(id)) continue;
    const continent = continentOf.get(id);
    if (continent === undefined) continue;
    if ((continentSizes.get(continent) ?? 0) <= keepAtLeast) continue;

    let landNeighbours = 0;
    let oceanNeighbours = 0;
    for (const neighbour of neighbors[id]) {
      if (land.has(neighbour)) landNeighbours += 1;
      else oceanNeighbours += 1;
    }
    if (!borderCells.has(id) && oceanNeighbours === 0) continue;
    if (landNeighbours <= 1) return id;

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
 * @param {number[]} order
 * @param {number} siteCount
 * @param {Set<number>} borderCells
 * @returns {number} Remaining lake count (should be 0).
 */
function removeLakes(
  land,
  neighbors,
  continentOf,
  order,
  siteCount,
  borderCells,
) {
  const targetSize = land.size;

  /** @type {number[]} */
  const lakes = [];
  for (let id = 0; id < siteCount; id += 1) {
    if (land.has(id) || borderCells.has(id)) continue;
    const adjacent = neighbors[id];
    if (adjacent.length === 0) continue;
    if (adjacent.every((neighbour) => land.has(neighbour))) lakes.push(id);
  }
  if (lakes.length === 0) return 0;

  const protectedCells = new Set(lakes);
  for (const lakeId of lakes) {
    land.add(lakeId);
    for (const neighbour of neighbors[lakeId]) {
      if (!land.has(neighbour)) continue;
      const continent = continentOf.get(neighbour);
      if (continent === undefined) continue;
      continentOf.set(lakeId, continent);
      break;
    }
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
      order,
      continentSizes,
      protectedCells,
      borderCells,
      1,
    );
    if (victim === null) break;
    const continent = continentOf.get(victim);
    land.delete(victim);
    continentOf.delete(victim);
    if (continent !== undefined) {
      continentSizes.set(continent, (continentSizes.get(continent) ?? 1) - 1);
    }
  }

  let remaining = 0;
  for (let id = 0; id < siteCount; id += 1) {
    if (land.has(id) || borderCells.has(id)) continue;
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
 * How many small islands to add and how many cities each one takes from the
 * continent edges.
 * @param {import('./rng.js').Rng} rng
 * @param {number} cityCount
 * @returns {number[]}
 */
function allocateIslandSizes(rng, cityCount) {
  if (cityCount < 40) return [];
  const count = cityCount >= 240 ? 3 : cityCount >= 120 ? 2 : 1;
  /** @type {number[]} */
  const sizes = [];
  for (let index = 0; index < count; index += 1) sizes.push(rng.int(2, 3));
  return sizes;
}

/**
 * Find the emptiest ocean cell for a new island: not owned, not adjacent to any
 * land, and as far as possible from existing land.
 * @param {Point[]} sites
 * @param {Map<number, number>} owner
 * @param {number[][]} neighbors
 * @param {Set<number>} borderCells
 * @returns {number}
 */
function pickIslandSpot(sites, owner, neighbors, borderCells) {
  let bestId = -1;
  let bestDistance = -Infinity;

  for (let id = 0; id < sites.length; id += 1) {
    if (owner.has(id) || borderCells.has(id)) continue;

    let blocked = false;
    for (const neighbour of neighbors[id]) {
      if (owner.has(neighbour)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    let nearest = Infinity;
    for (const claimedId of owner.keys()) {
      const distance = Math.hypot(
        sites[claimedId][0] - sites[id][0],
        sites[claimedId][1] - sites[id][1],
      );
      if (distance < nearest) nearest = distance;
    }
    if (nearest > bestDistance) {
      bestDistance = nearest;
      bestId = id;
    }
  }

  return bestId;
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
  // Scales with GENERATION_AREA_SCALE so cell size (and land area) stays put.
  const width = options.width ?? 3200 + dimensionRng.int(0, 460);
  const height = options.height ?? 1890 + dimensionRng.int(0, 460);
  if (!(width > 0) || !(height > 0)) {
    throw new RangeError('width and height must be positive');
  }

  const layoutRng = createRng(deriveSeed(seed, 'layout'));
  const landCandidateFraction = layoutRng.range(0.7, 0.78);
  const continentTarget = continentCountFor(cityCount);
  const candidateCount = Math.max(
    cityCount + continentTarget,
    Math.ceil((cityCount / landCandidateFraction) * GENERATION_AREA_SCALE),
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

  // Cells touching the inset rectangle are open to the outer ocean; they are
  // never lakes and are safe to remove without enclosing water.
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
  const trimRng = createRng(deriveSeed(seed, 'trim'));
  const trimOrder = trimRng.shuffle(sites.map((_, id) => id));

  /** @type {Set<number>} */
  let land = new Set();
  /** @type {Map<number, number>} */
  let continentOf = new Map();
  let built = false;

  let islandCount = 0;

  for (let attempt = 0; attempt < 10 && !built; attempt += 1) {
    const centers = pickContinentCenters(layoutRng, insetBounds, continentTarget);
    const islandSizes = allocateIslandSizes(layoutRng, cityCount);
    const islandCells = islandSizes.reduce((sum, size) => sum + size, 0);
    const sizes = allocateContinentSizes(
      layoutRng,
      cityCount - islandCells,
      continentTarget,
    );
    /** @type {Map<number, number>} */
    const owner = new Map();
    /** @type {Set<number>} */
    const claimed = new Set();
    let ok = true;

    for (let continent = 0; continent < continentTarget; continent += 1) {
      const shape = createContinentShape(
        createRng(deriveSeed(seed, `continent:${attempt}:${continent}`)),
        centers[continent],
        insetBounds,
        coastNoise,
      );
      const values = sites.map(([x, y]) => shape.value(x, y));
      const order = sites
        .map((_, id) => id)
        .sort((a, b) => values[a] - values[b]);
      const target = sizes[continent];
      const erosionBudget = Math.max(2, Math.ceil(target * 0.25));
      const selected = selectContinentCells(
        order,
        target + erosionBudget,
        owner,
        neighbors,
        continent,
      );
      if (selected === null) {
        ok = false;
        break;
      }
      erodeContinent(
        selected,
        target,
        owner,
        neighbors,
        continent,
        createRng(deriveSeed(seed, `erosion:${attempt}:${continent}`)),
        borderCells,
      );
      for (const id of selected) claimed.add(id);
    }

    // Islands: take a couple of cities from the continent edges and place them
    // in the emptiest ocean spots.
    for (
      let island = 0;
      ok && island < islandSizes.length;
      island += 1
    ) {
      const spot = pickIslandSpot(sites, owner, neighbors, borderCells);
      if (spot < 0) {
        ok = false;
        break;
      }
      const center = sites[spot];
      const distances = sites.map(([x, y]) =>
        Math.hypot(x - center[0], y - center[1]),
      );
      const order = sites
        .map((_, id) => id)
        .sort((a, b) => distances[a] - distances[b]);
      const selected = selectContinentCells(
        order,
        islandSizes[island],
        owner,
        neighbors,
        continentTarget + island,
      );
      if (selected === null) {
        ok = false;
        break;
      }
      for (const id of selected) claimed.add(id);
    }

    if (!ok) continue;
    land = claimed;
    continentOf = owner;
    islandCount = islandSizes.length;
    built = true;
  }

  if (!built) throw new Error('Failed to build the continent layout');

  // Erosion may leave a few extra cells; trim back to the exact city count.
  const layoutComponents = findComponents(land, neighbors);
  continentOf = layoutComponents.continentOf;
  if (land.size > cityCount) {
    /** @type {Map<number, number>} */
    const continentSizes = new Map();
    for (const id of land) {
      const continent = continentOf.get(id) ?? 0;
      continentSizes.set(continent, (continentSizes.get(continent) ?? 0) + 1);
    }
    while (land.size > cityCount) {
      const victim = findRemovableCell(
        land,
        neighbors,
        continentOf,
        trimOrder,
        continentSizes,
        new Set(),
        borderCells,
        2,
      );
      if (victim === null) break;
      const continent = continentOf.get(victim);
      land.delete(victim);
      continentOf.delete(victim);
      if (continent !== undefined) {
        continentSizes.set(continent, (continentSizes.get(continent) ?? 1) - 1);
      }
    }
  }

  const lakeCount = removeLakes(
    land,
    neighbors,
    continentOf,
    trimOrder,
    candidateCount,
    borderCells,
  );

  const refreshed = findComponents(land, neighbors);
  /** @type {Map<number, number>} */
  const continentSizesById = new Map();
  for (const id of land) {
    const continent = refreshed.continentOf.get(id) ?? 0;
    continentSizesById.set(continent, (continentSizesById.get(continent) ?? 0) + 1);
  }

  const basePolygons = jitterCells(cells, seed);
  const landIdList = [...land].sort((a, b) => a - b);
  /** @type {Map<number, number>} */
  const landIndex = new Map();
  landIdList.forEach((oldId, index) => landIndex.set(oldId, index));

  const warp = createWarp(seed);
  const polygons = landIdList.map((oldId) => basePolygons[oldId].map(warp));
  const warpedSites = landIdList.map((oldId) => warp(sites[oldId]));

  const names = generateNames(createRng(deriveSeed(seed, 'names')), landIdList.length);
  const terrains = assignTerrains(warpedSites, width, height, seed);

  let areaSum = 0;
  for (const polygon of polygons) areaSum += Math.abs(polygonArea(polygon));

  // Enlarge the world until the ocean covers 70% of it, then place the land
  // somewhere inside the frame (random, not forced to the centre).
  const targetWorldArea = areaSum / (1 - OCEAN_FRACTION);
  const scale = Math.sqrt(targetWorldArea / (width * height));
  let finalWidth = Math.round(width * scale);
  let finalHeight = Math.round(height * scale);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons) {
    for (const [x, y] of polygon) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const landWidth = maxX - minX;
  const landHeight = maxY - minY;
  const padding = Math.max(8, Math.round(Math.min(width, height) * 0.012));
  finalWidth = Math.max(finalWidth, Math.ceil(landWidth + padding * 2));
  finalHeight = Math.max(finalHeight, Math.ceil(landHeight + padding * 2));

  const offsetX = layoutRng.range(
    padding - minX,
    Math.max(padding - minX, finalWidth - padding - maxX),
  );
  const offsetY = layoutRng.range(
    padding - minY,
    Math.max(padding - minY, finalHeight - padding - maxY),
  );

  const finalPolygons = polygons.map((polygon) =>
    polygon.map(([x, y]) => /** @type {Point} */ ([x + offsetX, y + offsetY])),
  );

  /** @type {MapCity[]} */
  const cities = finalPolygons.map((polygon, index) => {
    const area = Math.abs(polygonArea(polygon));
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

  const worldArea = finalWidth * finalHeight;
  const continentSizes = [...continentSizesById.values()].sort((a, b) => b - a);

  return {
    seed,
    width: finalWidth,
    height: finalHeight,
    cities,
    meta: {
      cityCount: cities.length,
      candidateCount,
      landArea: areaSum,
      worldArea,
      landAreaFraction: areaSum / worldArea,
      continentCount: continentSizes.length,
      continentSizes,
      islandCount,
      lakeCount,
    },
  };
}
