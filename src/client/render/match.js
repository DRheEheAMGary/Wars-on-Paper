// @ts-check
/**
 * Canvas renderer for the single-player match: ownership fills, city markers,
 * garrison numbers, selection, hover and marching armies.
 */

import { pointInPolygon } from '../../shared/geometry.js';
import { TERRAIN_FILLS } from './map.js';

const FONT_STACK =
  "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif";

const OCEAN_FILL = '#e7f0f5';
const BORDER_COLOR = 'rgba(17, 17, 17, 0.10)';
const WORLD_BORDER = '#1b1b1b';
const ACCENT = '#e0492f';
const LABEL_MIN_ZOOM = 0.55;
const GARRISON_MIN_ZOOM = 0.75;

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
 * @param {any} state
 * @param {number} owner
 * @returns {string}
 */
function ownerColor(state, owner) {
  return state.players[owner]?.color ?? '#d24a35';
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../../shared/mapgen.js').GameMap} map
 * @param {any} state
 * @param {import('./camera.js').Camera} camera
 * @param {{ viewWidth: number, viewHeight: number, dpr?: number, hoverId?: number, selectedId?: number, tick?: number }} options
 */
export function drawMatch(ctx, map, state, camera, options) {
  const {
    viewWidth,
    viewHeight,
    dpr = 1,
    hoverId = -1,
    selectedId = -1,
    tick = state.tick,
  } = options;
  const { zoom } = camera;
  const screen = (/** @type {number} */ pixels) => pixels / zoom;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewWidth, viewHeight);

  ctx.save();
  ctx.translate(viewWidth / 2, viewHeight / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-camera.centerX, -camera.centerY);

  ctx.fillStyle = OCEAN_FILL;
  ctx.fillRect(0, 0, map.width, map.height);

  const cityStates = state.cities;

  // Territory fills.
  for (const city of map.cities) {
    const owner = cityStates[city.id]?.owner ?? null;
    tracePolygon(ctx, city.polygon);
    if (owner === null) {
      ctx.fillStyle = TERRAIN_FILLS[city.terrain];
      ctx.fill();
      continue;
    }
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = ownerColor(state, owner);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Cell borders.
  ctx.strokeStyle = BORDER_COLOR;
  ctx.lineWidth = screen(1);
  for (const city of map.cities) {
    tracePolygon(ctx, city.polygon);
    ctx.stroke();
  }

  // Hover and selection outlines.
  if (hoverId >= 0 && map.cities[hoverId]) {
    tracePolygon(ctx, map.cities[hoverId].polygon);
    ctx.fillStyle = 'rgba(224, 73, 47, 0.10)';
    ctx.fill();
  }
  if (selectedId >= 0 && map.cities[selectedId]) {
    tracePolygon(ctx, map.cities[selectedId].polygon);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = screen(2.4);
    ctx.stroke();
  }

  // City crosses.
  ctx.strokeStyle = 'rgba(27, 27, 27, 0.55)';
  ctx.lineWidth = screen(1.1);
  const arm = screen(2.6);
  for (const city of map.cities) {
    const [x, y] = city.center;
    ctx.beginPath();
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm);
    ctx.lineTo(x, y + arm);
    ctx.stroke();
  }

  // City names with simple collision skipping.
  if (zoom >= LABEL_MIN_ZOOM) {
    ctx.font = `${screen(11)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = screen(3);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillStyle = '#3c3c3c';
    /** @type {{ left: number, right: number, top: number, bottom: number }[]} */
    const placed = [];
    const height = screen(13);
    for (const city of map.cities) {
      const x = city.center[0];
      const y = city.center[1] - screen(9);
      const half = ctx.measureText(city.name).width / 2 + screen(2);
      const box = { left: x - half, right: x + half, top: y - height / 2, bottom: y + height / 2 };
      const overlaps = placed.some(
        (other) =>
          box.left < other.right &&
          box.right > other.left &&
          box.top < other.bottom &&
          box.bottom > other.top,
      );
      if (overlaps) continue;
      placed.push(box);
      ctx.strokeText(city.name, x, y);
      ctx.fillText(city.name, x, y);
    }
  }

  // Garrison numbers.
  if (zoom >= GARRISON_MIN_ZOOM) {
    ctx.font = `${screen(10)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#2c2a25';
    for (const city of map.cities) {
      const cityState = cityStates[city.id];
      if (!cityState || cityState.garrison <= 0) continue;
      ctx.fillText(
        String(cityState.garrison),
        city.center[0],
        city.center[1] + screen(11),
      );
    }
  }

  // Armies.
  for (const army of state.armies) {
    const from = map.cities[army.fromCity];
    const to = map.cities[army.toCity];
    if (!from || !to) continue;
    const span = Math.max(1, army.arriveTick - army.departTick);
    const progress = Math.max(0, Math.min(1, (tick - army.departTick) / span));
    const x = from.center[0] + (to.center[0] - from.center[0]) * progress;
    const y = from.center[1] + (to.center[1] - from.center[1]) * progress;

    ctx.strokeStyle = ownerColor(state, army.owner);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = screen(1.4);
    ctx.setLineDash([screen(4), screen(3)]);
    ctx.beginPath();
    ctx.moveTo(from.center[0], from.center[1]);
    ctx.lineTo(to.center[0], to.center[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(x, y, screen(3.2), 0, Math.PI * 2);
    ctx.fillStyle = ownerColor(state, army.owner);
    ctx.fill();

    ctx.font = `${screen(10)}px ${FONT_STACK}`;
    ctx.fillStyle = '#1b1b1b';
    ctx.fillText(String(army.soldiers), x, y - screen(8));
  }

  ctx.strokeStyle = WORLD_BORDER;
  ctx.lineWidth = screen(1.5);
  ctx.strokeRect(0, 0, map.width, map.height);

  ctx.restore();
}

/**
 * @param {import('../../shared/mapgen.js').GameMap} map
 * @param {[number, number]} point
 * @param {number} [tolerance]
 * @returns {number}
 */
export function cityAt(map, point, tolerance = 0) {
  for (const city of map.cities) {
    if (pointInPolygon(point, city.polygon)) return city.id;
  }
  if (tolerance <= 0) return -1;
  let best = -1;
  let bestDistance = tolerance;
  for (const city of map.cities) {
    const distance = Math.hypot(city.center[0] - point[0], city.center[1] - point[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = city.id;
    }
  }
  return best;
}
