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
const OUTLINE_COLOR = '#1b1b1b';
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

  tracePolygon(ctx, map.outline);
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = screen(1.5);
  ctx.stroke();

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
    for (const city of map.cities) {
      const labelY = city.center[1] - screen(9);
      ctx.strokeText(city.name, city.center[0], labelY);
      ctx.fillText(city.name, city.center[0], labelY);
    }
  }

  ctx.restore();
}
