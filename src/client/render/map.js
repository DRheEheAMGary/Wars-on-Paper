// @ts-check
/**
 * Canvas renderer for the generated map.
 * White, minimal visual language: hairline borders, subtle terrain tints,
 * vivid accent reserved for hover and future player colours.
 */

import { pointInPolygon } from '../../shared/geometry.js';

/** @typedef {import('../../shared/mapgen.js').GameMap} GameMap */
/** @typedef {import('../../shared/mapgen.js').MapCity} MapCity */
/** @typedef {import('./camera.js').Camera} Camera */

export const TERRAIN_FILLS = {
  plains: '#f7f5ef',
  forest: '#eaf1e5',
  hills: '#f3ecdf',
  mountain: '#e7e3dc',
};

const FONT_STACK =
  "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif";

const BORDER_COLOR = 'rgba(17, 17, 17, 0.10)';
const WORLD_BORDER_COLOR = '#1b1b1b';
const OCEAN_FILL = '#e7f0f5';
const ACCENT = '#e0492f';
const LABEL_MIN_ZOOM = 0.5;

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {[number, number][]} polygon
 */
function tracePolygon(ctx, polygon) {
  const first = polygon[0];
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (let i = 1; i < polygon.length; i += 1) {
    ctx.lineTo(polygon[i][0], polygon[i][1]);
  }
  ctx.closePath();
}

/**
 * @param {GameMap} map
 * @param {[number, number]} point
 * @param {number} [tolerance] World units; 0 disables the nearest-centre fallback.
 * @returns {number} City id or -1.
 */
export function findCityAt(map, point, tolerance = 0) {
  for (const city of map.cities) {
    if (pointInPolygon(point, city.polygon)) return city.id;
  }
  if (tolerance <= 0) return -1;

  let bestId = -1;
  let bestDistance = tolerance;
  for (const city of map.cities) {
    const dx = city.center[0] - point[0];
    const dy = city.center[1] - point[1];
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = city.id;
    }
  }
  return bestId;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {GameMap} map
 * @param {Camera} camera
 * @param {{
 *   viewWidth: number,
 *   viewHeight: number,
 *   dpr?: number,
 *   showAdjacency?: boolean,
 *   showNames?: boolean,
 *   hoverId?: number,
 * }} options
 */
export function drawMap(ctx, map, camera, options) {
  const {
    viewWidth,
    viewHeight,
    dpr = 1,
    showAdjacency = false,
    showNames = true,
    hoverId = -1,
  } = options;
  const { zoom } = camera;
  const screen = (pixels) => pixels / zoom;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewWidth, viewHeight);

  ctx.save();
  ctx.translate(viewWidth / 2, viewHeight / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-camera.centerX, -camera.centerY);

  // Ocean fills the rectangular world; land territories are drawn on top.
  ctx.fillStyle = OCEAN_FILL;
  ctx.fillRect(0, 0, map.width, map.height);

  for (const city of map.cities) {
    tracePolygon(ctx, city.polygon);
    ctx.fillStyle = TERRAIN_FILLS[city.terrain];
    ctx.fill();
  }

  ctx.strokeStyle = BORDER_COLOR;
  ctx.lineWidth = screen(1);
  for (const city of map.cities) {
    tracePolygon(ctx, city.polygon);
    ctx.stroke();
  }

  // Rectangular map frame.
  ctx.strokeStyle = WORLD_BORDER_COLOR;
  ctx.lineWidth = screen(1.5);
  ctx.strokeRect(0, 0, map.width, map.height);

  if (showAdjacency) {
    ctx.save();
    ctx.strokeStyle = 'rgba(17, 17, 17, 0.13)';
    ctx.lineWidth = screen(1);
    ctx.setLineDash([screen(4), screen(4)]);
    for (const city of map.cities) {
      for (const neighbourId of city.neighbors) {
        if (neighbourId <= city.id) continue;
        const neighbour = map.cities[neighbourId];
        ctx.beginPath();
        ctx.moveTo(city.center[0], city.center[1]);
        ctx.lineTo(neighbour.center[0], neighbour.center[1]);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  if (hoverId >= 0 && map.cities[hoverId]) {
    tracePolygon(ctx, map.cities[hoverId].polygon);
    ctx.fillStyle = 'rgba(224, 73, 47, 0.12)';
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = screen(2);
    ctx.stroke();
  }

  ctx.fillStyle = '#1b1b1b';
  for (const city of map.cities) {
    ctx.beginPath();
    ctx.arc(city.center[0], city.center[1], screen(2.2), 0, Math.PI * 2);
    ctx.fill();
  }

  if (showNames && zoom >= LABEL_MIN_ZOOM) {
    ctx.font = `${screen(11)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = screen(3);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillStyle = '#3c3c3c';

    /** @type {{ left: number, right: number, top: number, bottom: number }[]} */
    const placed = [];
    const labelHeight = screen(13);
    for (const city of map.cities) {
      const labelX = city.center[0];
      const labelY = city.center[1] - screen(9);
      const halfWidth = ctx.measureText(city.name).width / 2 + screen(2);
      const box = {
        left: labelX - halfWidth,
        right: labelX + halfWidth,
        top: labelY - labelHeight / 2,
        bottom: labelY + labelHeight / 2,
      };
      const overlaps = placed.some(
        (other) =>
          box.left < other.right &&
          box.right > other.left &&
          box.top < other.bottom &&
          box.bottom > other.top,
      );
      if (overlaps) continue;

      placed.push(box);
      ctx.strokeText(city.name, labelX, labelY);
      ctx.fillText(city.name, labelX, labelY);
    }
  }

  ctx.restore();
}
