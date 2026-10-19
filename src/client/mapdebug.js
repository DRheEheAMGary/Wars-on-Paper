// @ts-check
/**
 * Map prototype page (M1): generate a seeded map, render it on canvas and
 * verify camera / adjacency / terrain by eye.
 */

import { generateMap, TERRAIN_LABELS } from '../shared/mapgen.js';
import { Camera } from './render/camera.js';
import { drawMap, findCityAt } from './render/map.js';

/** @param {string} id @returns {HTMLElement} */
function mustElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

const canvasElement = document.getElementById('map');
if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error('Missing canvas #map');
}
const canvas = canvasElement;
const context = canvas.getContext('2d');
if (!context) throw new Error('Canvas 2D is not available');

const seedInput = mustElement('seed');
const citySelect = mustElement('cities');
const regenerateButton = mustElement('regenerate');
const adjacencyToggle = mustElement('toggle-adjacency');
const namesToggle = mustElement('toggle-names');
const statsElement = mustElement('stats');
const renderTimeElement = mustElement('render-time');
const hoverElement = mustElement('hover');

if (
  !(seedInput instanceof HTMLInputElement) ||
  !(citySelect instanceof HTMLSelectElement) ||
  !(regenerateButton instanceof HTMLButtonElement) ||
  !(adjacencyToggle instanceof HTMLInputElement) ||
  !(namesToggle instanceof HTMLInputElement)
) {
  throw new Error('Unexpected map debug controls');
}

const ALLOWED_CITY_COUNTS = new Set([60, 100, 160, 240, 360]);
const params = new URLSearchParams(window.location.search);
const initialSeed = Math.trunc(Number(params.get('seed'))) || 1;
const requestedCount = Math.trunc(Number(params.get('cities')));
const initialCount = ALLOWED_CITY_COUNTS.has(requestedCount) ? requestedCount : 160;

/** @type {import('../shared/mapgen.js').GameMap} */
let map = generateMap({ seed: initialSeed, cityCount: initialCount });
/** @type {Camera} */
let camera = new Camera(map.width, map.height);
let hoverId = -1;
let dragging = false;
let lastPointerX = 0;
let lastPointerY = 0;

/** @param {number} seed @param {number} cityCount */
function regenerate(seed, cityCount) {
  const startedAt = performance.now();
  map = generateMap({ seed, cityCount });
  const generationMs = performance.now() - startedAt;

  camera = new Camera(map.width, map.height);
  camera.resize(window.innerWidth, window.innerHeight);
  hoverId = -1;

  seedInput.value = String(map.seed);
  citySelect.value = String(cityCount);
  statsElement.textContent =
    `${map.cities.length} 座城市 · 种子 ${map.seed} · 生成 ` +
    `${generationMs.toFixed(0)} ms · ` +
    `${map.meta.continentCount - map.meta.islandCount} 块大陆 + ` +
    `${map.meta.islandCount} 座岛屿 · ` +
    `陆地 ${(map.meta.landAreaFraction * 100).toFixed(1)}% · ` +
    `海洋 ${((1 - map.meta.landAreaFraction) * 100).toFixed(1)}%`;
  updateHoverInfo();

  const url = new URL(window.location.href);
  url.searchParams.set('seed', String(map.seed));
  url.searchParams.set('cities', String(map.cities.length));
  window.history.replaceState(null, '', url);

  document.title = `${map.cities.length} 城 · 地图原型 · Wars on Paper`;
  requestDraw();
}

function updateHoverInfo() {
  if (hoverId < 0) {
    hoverElement.textContent = '悬停城市查看信息';
    return;
  }
  const city = map.cities[hoverId];
  hoverElement.textContent =
    `${city.name} · ${TERRAIN_LABELS[city.terrain]} · ` +
    `邻接 ${city.neighbors.length} · 面积 ${(city.area / 1000).toFixed(1)}k`;
}

/** @param {number} screenX @param {number} screenY */
function updateHoverAt(screenX, screenY) {
  const world = camera.screenToWorld(screenX, screenY);
  const next = findCityAt(map, world, 16 / camera.zoom);
  if (next === hoverId) return;
  hoverId = next;
  updateHoverInfo();
  requestDraw();
}

let frameQueued = false;

function requestDraw() {
  if (frameQueued) return;
  frameQueued = true;
  window.requestAnimationFrame(() => {
    frameQueued = false;
    render();
  });
}

function render() {
  const startedAt = performance.now();
  drawMap(context, map, camera, {
    viewWidth: window.innerWidth,
    viewHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    showAdjacency: adjacencyToggle.checked,
    showNames: namesToggle.checked,
    hoverId,
  });
  const renderMs = performance.now() - startedAt;
  renderTimeElement.textContent = `帧渲染 ${renderMs.toFixed(1)} ms`;
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  camera.resize(width, height);
  requestDraw();
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  dragging = true;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('is-dragging');
});

canvas.addEventListener('pointermove', (event) => {
  if (dragging) {
    camera.panPixels(event.clientX - lastPointerX, event.clientY - lastPointerY);
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    requestDraw();
    return;
  }
  updateHoverAt(event.clientX, event.clientY);
});

/** @param {PointerEvent} event */
function endDrag(event) {
  if (!dragging) return;
  dragging = false;
  canvas.classList.remove('is-dragging');
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('pointerleave', () => {
  if (hoverId < 0) return;
  hoverId = -1;
  updateHoverInfo();
  requestDraw();
});

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    camera.zoomAt(event.clientX, event.clientY, factor);
    updateHoverAt(event.clientX, event.clientY);
    requestDraw();
  },
  { passive: false },
);

canvas.addEventListener('dblclick', () => {
  camera.fit();
  requestDraw();
});

regenerateButton.addEventListener('click', () => {
  const seed = Math.trunc(Number(seedInput.value)) || 1;
  const cityCount = ALLOWED_CITY_COUNTS.has(Number(citySelect.value))
    ? Number(citySelect.value)
    : 160;
  regenerate(seed, cityCount);
});

seedInput.addEventListener('change', () => {
  regenerateButton.click();
});

citySelect.addEventListener('change', () => {
  regenerateButton.click();
});

adjacencyToggle.addEventListener('change', requestDraw);
namesToggle.addEventListener('change', requestDraw);
window.addEventListener('resize', resizeCanvas);

seedInput.value = String(initialSeed);
citySelect.value = String(initialCount);
resizeCanvas();
regenerate(initialSeed, initialCount);
