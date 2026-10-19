// @ts-check
/**
 * Small, dependency-free polygon helpers used by map generation and rendering.
 * All functions are pure and operate on arrays of [x, y] tuples.
 */

/** @typedef {[number, number]} Point */

export const EPSILON = 1e-9;

/**
 * @param {Point} a
 * @param {Point} b
 * @returns {number}
 */
export function distance(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/**
 * Signed area of a polygon (positive for counter-clockwise winding).
 * @param {Point[]} polygon
 * @returns {number}
 */
export function polygonArea(polygon) {
  let sum = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/**
 * Area-weighted centroid, falling back to the vertex average for degenerate polygons.
 * @param {Point[]} polygon
 * @returns {Point}
 */
export function polygonCentroid(polygon) {
  let area = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const cross = a[0] * b[1] - b[0] * a[1];
    area += cross;
    x += (a[0] + b[0]) * cross;
    y += (a[1] + b[1]) * cross;
  }
  if (Math.abs(area) < EPSILON) {
    let sx = 0;
    let sy = 0;
    for (const point of polygon) {
      sx += point[0];
      sy += point[1];
    }
    return [sx / polygon.length, sy / polygon.length];
  }
  return [x / (3 * area), y / (3 * area)];
}

/**
 * @param {Point[]} polygon
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
export function polygonBounds(polygon) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Ray-casting point-in-polygon test. Works for convex and concave polygons.
 * @param {Point} point
 * @param {Point[]} polygon
 * @returns {boolean}
 */
export function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Clip a polygon by the half-plane `nx * x + ny * y <= offset`
 * (Sutherland–Hodgman against a single line).
 * @param {Point[]} polygon
 * @param {number} nx
 * @param {number} ny
 * @param {number} offset
 * @returns {Point[]}
 */
export function clipPolygonHalfPlane(polygon, nx, ny, offset) {
  /** @param {Point} point */
  const signed = (point) => nx * point[0] + ny * point[1] - offset;
  /** @type {Point[]} */
  const output = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const da = signed(a);
    const db = signed(b);
    const aInside = da <= EPSILON;
    const bInside = db <= EPSILON;

    if (aInside) output.push(a);
    if (aInside !== bInside) {
      const t = da / (da - db);
      output.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return output;
}

/**
 * Closed Chaikin corner cutting. Keeps convex polygons convex.
 * @param {Point[]} points
 * @param {number} [iterations]
 * @returns {Point[]}
 */
export function chaikin(points, iterations = 1) {
  let current = points;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    /** @type {Point[]} */
    const next = [];
    for (let i = 0; i < current.length; i += 1) {
      const a = current[i];
      const b = current[(i + 1) % current.length];
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    current = next;
  }
  return current;
}

/**
 * Andrew's monotone chain convex hull (counter-clockwise).
 * @param {Point[]} points
 * @returns {Point[]}
 */
export function convexHull(points) {
  /** @type {Point[]} */
  const sorted = points
    .slice()
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((point, index, list) => {
      if (index === 0) return true;
      const previous = list[index - 1];
      return point[0] !== previous[0] || point[1] !== previous[1];
    });

  if (sorted.length <= 2) return sorted;

  /** @param {Point} o @param {Point} a @param {Point} b */
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  /** @type {Point[]} */
  const lower = [];
  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }

  /** @type {Point[]} */
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
