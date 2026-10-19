// @ts-check
/**
 * Single-player match page: canvas renderer + DOM HUD, talks to the simulation
 * worker. M2 core loop (economy, recruiting, marching, combat, capture).
 */

import { Camera } from './render/camera.js';
import { drawMatch, cityAt } from './render/match.js';
import { estimateBattle } from '../shared/combat.js';

/** @param {string} id @returns {HTMLElement} */
function mustElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

const canvasElement = document.getElementById('game');
if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error('Missing canvas #game');
}
const canvas = canvasElement;
const context = canvas.getContext('2d');
if (!context) throw new Error('Canvas 2D is not available');

const panelElement = mustElement('city-panel');
const toastElement = mustElement('toast');
const resultElement = mustElement('result');
const resultTitle = mustElement('result-title');
const resultDetail = mustElement('result-detail');
const statGold = mustElement('stat-gold');
const statFood = mustElement('stat-food');
const statCities = mustElement('stat-cities');
const statScore = mustElement('stat-score');
const statTimer = mustElement('stat-timer');
const standingsElement = mustElement('standings');
const resultRanking = mustElement('result-ranking');
const pauseButton = mustElement('button-pause');
const speedButton = mustElement('button-speed');

const CITY_COUNTS = new Set([60, 100, 160, 240, 360]);
const params = new URLSearchParams(window.location.search);
const requestedCities = Number(params.get('cities'));
const cityCount = CITY_COUNTS.has(requestedCities) ? requestedCities : 160;
const seed = Number(params.get('seed')) || Math.floor(Math.random() * 1_000_000);

const balance = await fetch('/data/balance.json', { cache: 'no-store' }).then(
  (response) => response.json(),
);

/** @type {any} */
let map = null;
/** @type {any} */
let snapshot = null;
let camera = new Camera(1, 1);
let selectedId = -1;
let hoverId = -1;
let paused = false;
let speed = 1;
let dragging = false;
let moved = false;
/** @type {'pan' | 'dispatch' | null} */
let dragMode = null;
let dispatchFrom = -1;
/** @type {[number, number] | null} */
let dispatchPoint = null;
let dispatchTarget = -1;
let dispatchAmount = 0;
let dispatchOdds = null;
let lastPointerX = 0;
let lastPointerY = 0;
let toastTimer = 0;
let drawQueued = false;
let panelCityId = -1;
/** @type {any} */
let panelRefs = null;

const worker = new Worker('/src/client/game-worker.js', { type: 'module' });
worker.onerror = (event) => {
  showToast(`模拟器启动失败：${event.message || '未知错误'}`);
};
worker.postMessage({ type: 'init', config: { seed, cityCount }, balance });

worker.onmessage = (event) => {
  const message = event.data;

  if (message.type === 'init') {
    map = message.map;
    snapshot = message.snapshot;
    camera = new Camera(map.width, map.height);
    resizeCanvas();
    updateHud();
    requestDraw();
    return;
  }

  if (message.type === 'snapshot') {
    snapshot = message.snapshot;
    updateHud();
    handleEvents(snapshot.events ?? []);
    if (selectedId >= 0) renderPanel();
    if (snapshot.phase !== 'playing') showResult();
    requestDraw();
  }
};

/** @param {string} tag @param {string} [className] @param {string} [text] */
function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function hidePanel() {
  panelElement.classList.add('hidden');
  panelElement.replaceChildren();
  panelCityId = -1;
  panelRefs = null;
}

function updateHud() {
  if (!snapshot) return;
  const player = snapshot.players[0];
  statGold.textContent = String(Math.floor(player.gold));
  statFood.textContent = String(Math.floor(player.food));
  statCities.textContent = String(player.cityCount);
  statScore.textContent = String(player.score);
  const elapsed = Math.floor((snapshot.tick * balance.tickMs) / 1000);
  const remaining = Math.max(0, balance.matchSeconds - elapsed);
  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, '0');
  statTimer.textContent = `${minutes}:${seconds}`;

  standingsElement.replaceChildren();
  for (const player of snapshot.players) {
    const chip = createElement('span', 'standing');
    const dot = createElement('i', 'standing-dot');
    dot.style.background = player.color;
    const label = createElement('span', '', `${player.name} ${player.cityCount}`);
    chip.append(dot, label);
    standingsElement.append(chip);
  }
}

/** @param {any[]} events */
function handleEvents(events) {
  for (const event of events) {
    if (event.type === 'captured') {
      showToast(`占领 ${map.cities[event.cityId]?.name ?? '城市'}`);
    } else if (event.type === 'battle') {
      const name = map.cities[event.cityId]?.name ?? '城市';
      showToast(
        `${name} 战斗：损失 ${event.attackerLoss}，歼敌 ${event.defenderLoss}`,
      );
    } else if (event.type === 'upgraded') {
      showToast(`${map.cities[event.cityId]?.name ?? '城市'} 升至 Lv.${event.level}`);
    } else if (event.type === 'reinforce') {
      showToast(`援军抵达 ${map.cities[event.cityId]?.name ?? '城市'}`);
    } else if (event.type === 'starvation') {
      showToast('粮食不足，部队减员');
    } else if (event.type === 'error') {
      showToast(event.message);
    }
  }
}

/** @param {string} message */
function showToast(message) {
  toastElement.textContent = message;
  toastElement.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastElement.classList.remove('visible');
  }, 2200);
}

function updateHoverAt(screenX, screenY) {
  if (!map || !camera) return;
  const world = camera.screenToWorld(screenX, screenY);
  const next = cityAt(map, world, 12 / camera.zoom);
  if (next !== hoverId) {
    hoverId = next;
    requestDraw();
  }
}

function militaryMultiplier() {
  const player = snapshot?.players[0];
  return 1 + (player?.tech?.military ? balance.researchEffects.military : 0);
}

function renderPanel() {
  if (!snapshot || selectedId < 0 || !map.cities[selectedId]) {
    hidePanel();
    return;
  }
  const cityState = snapshot.cities[selectedId];
  const owned = cityState.owner === 0;
  // Rebuild only when the selected city or its ownership changes; snapshots
  // otherwise update values in place so clicks are never swallowed by a rebuild.
  if (!panelRefs || panelCityId !== selectedId || panelRefs.owned !== owned) {
    buildPanel();
  } else {
    updatePanel();
  }
}

function buildPanel() {
  const city = map.cities[selectedId];
  const cityState = snapshot.cities[selectedId];
  const owned = cityState.owner === 0;
  panelCityId = selectedId;
  panelRefs = { cityId: selectedId, owned, research: new Map(), rows: new Map() };

  panelElement.classList.remove('hidden');
  panelElement.replaceChildren();

  panelElement.append(
    createElement('h3', 'panel-title', city.name),
    (panelRefs.sub = createElement('p', 'panel-sub', '')),
  );

  if (owned) {
    const actions = createElement('div', 'panel-actions');

    panelRefs.recruit = createElement('button', '');
    panelRefs.recruit.addEventListener('click', () => {
      worker.postMessage({
        type: 'command',
        command: { type: 'recruit', cityId: selectedId },
      });
    });

    panelRefs.upgrade = createElement('button', '');
    panelRefs.upgrade.addEventListener('click', () => {
      worker.postMessage({
        type: 'command',
        command: { type: 'upgrade', cityId: selectedId },
      });
    });

    actions.append(panelRefs.recruit, panelRefs.upgrade);
    panelElement.append(actions);

    panelRefs.upgradeInfo = createElement('p', 'panel-sub', '');
    panelElement.append(panelRefs.upgradeInfo);

    panelElement.append(createElement('p', 'panel-label', '科技'));
    const researchList = createElement('div', 'research-list');
    for (const tech of balance.research ?? []) {
      const button = createElement('button', '');
      button.addEventListener('click', () => {
        worker.postMessage({
          type: 'command',
          command: { type: 'research', techId: tech.id },
        });
      });
      researchList.append(button);
      panelRefs.research.set(tech.id, { button, tech });
    }
    panelElement.append(researchList);
  }

  if (owned) {
    panelElement.append(createElement('p', 'panel-label', '派兵数量'));
    const dispatch = createElement('div', 'dispatch dispatch-amount');

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'dispatch-range';
    slider.min = '1';
    const garrison = cityState.garrison;
    slider.max = String(Math.max(1, garrison));
    slider.value = String(Math.max(1, Math.floor(garrison / 2)));
    const count = createElement('span', 'dispatch-count', slider.value);
    slider.addEventListener('input', () => {
      count.textContent = slider.value;
    });

    dispatch.append(slider, count);
    panelElement.append(dispatch);
    panelElement.append(
      createElement(
        'p',
        'panel-sub',
        '按住已选中的城市，拖到相邻或渡海城市派兵；拖到自己的城市即可调兵。',
      ),
    );
    panelRefs.amountSlider = slider;
    panelRefs.amountCount = count;
  } else {
    panelElement.append(
      createElement('p', 'panel-sub', '点击你自己的城市选中后，按住城市拖到目标城市即可派兵。'),
    );
  }

  updatePanel();
}

function updatePanel() {
  if (!panelRefs || !snapshot) return;
  const cityState = snapshot.cities[panelCityId];
  if (!cityState) return;
  const player = snapshot.players[0];
  const config =
    balance.cityLevels[Math.min(cityState.level, balance.cityLevels.length) - 1];

  panelRefs.sub.textContent =
    `Lv.${cityState.level} · 人口 ${cityState.population} · 驻军 ${cityState.garrison}` +
    (panelRefs.owned ? '' : ' · 中立城市（点击你自己的城市才能操作）');

  if (panelRefs.owned) {
    const recruitCost = balance.soldierCostGold * balance.recruitBatch;
    const recruitPopulation = balance.soldierCostPopulation * balance.recruitBatch;
    panelRefs.recruit.textContent =
      `招募 ${balance.recruitBatch} 兵（${recruitCost} 金 / ${recruitPopulation} 人口）`;
    panelRefs.recruit.disabled =
      player.gold < recruitCost ||
      cityState.population < recruitPopulation ||
      cityState.garrison + balance.recruitBatch > config.garrisonCap;

    panelRefs.upgrade.textContent =
      cityState.level >= balance.cityLevels.length
        ? '已满级'
        : cityState.upgrading
          ? '升级中…'
          : `升级至 Lv.${cityState.level + 1}（${config.upgradeGold} 金）`;
    panelRefs.upgrade.disabled =
      cityState.level >= balance.cityLevels.length ||
      Boolean(cityState.upgrading) ||
      (config.upgradeGold !== null && player.gold < config.upgradeGold);

    if (cityState.upgrading) {
      const remaining = Math.max(0, cityState.upgrading.endsTick - snapshot.tick);
      panelRefs.upgradeInfo.textContent = `升级中… 剩余 ${Math.ceil(remaining / 10)} 秒`;
    } else {
      panelRefs.upgradeInfo.textContent = '';
    }

    for (const [techId, entry] of panelRefs.research) {
      const researched = Boolean(player.tech?.[techId]);
      entry.button.textContent = researched
        ? `${entry.tech.name} · 已研发`
        : `${entry.tech.name}（${entry.tech.description}）· ${entry.tech.costGold} 金`;
      entry.button.disabled = researched || player.gold < entry.tech.costGold;
    }
  }

  if (panelRefs.amountSlider) {
    const garrison = cityState.garrison;
    panelRefs.amountSlider.max = String(Math.max(1, garrison));
    let value = Number(panelRefs.amountSlider.value);
    if (!Number.isFinite(value) || value < 1) value = 1;
    if (value > garrison) value = Math.max(1, garrison);
    panelRefs.amountSlider.value = String(value);
    panelRefs.amountCount.textContent = String(garrison <= 0 ? 0 : value);
  }
}

function showResult() {
  if (!snapshot.result) return;
  const outcome = snapshot.result.outcome;
  resultTitle.textContent =
    outcome === 'won' ? '胜利' : outcome === 'lost' ? '战败' : '时间到';
  resultDetail.textContent =
    `分数 ${snapshot.result.score} · 城市 ${snapshot.result.cities} · ` +
    `歼敌 ${Math.round(snapshot.result.kills)}` +
    (snapshot.result.rank ? ` · 第 ${snapshot.result.rank} 名` : '');

  resultRanking.replaceChildren();
  (snapshot.result.ranking ?? []).forEach((entry, index) => {
    const row = createElement(
      'div',
      entry.id === 0 ? 'result-row me' : 'result-row',
    );
    const dot = createElement('i', 'standing-dot');
    dot.style.background = entry.color;
    row.append(
      dot,
      createElement(
        'span',
        '',
        `${index + 1}. ${entry.name} · ${entry.cityCount} 城 · ${entry.score} 分`,
      ),
    );
    resultRanking.append(row);
  });

  resultElement.classList.remove('hidden');
}

function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  window.requestAnimationFrame(() => {
    drawQueued = false;
    render();
  });
}

function render() {
  if (!map || !snapshot) return;
  drawMatch(context, map, snapshot, camera, {
    viewWidth: window.innerWidth,
    viewHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    hoverId,
    selectedId,
    tick: snapshot.tick,
    dispatchFrom,
    dispatchPoint,
    dispatchTarget,
    dispatchAmount,
    dispatchOdds,
  });
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
  moved = false;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('is-dragging');

  if (!map || !snapshot) {
    dragMode = 'pan';
    dragging = true;
    return;
  }

  const world = camera.screenToWorld(event.clientX, event.clientY);
  const id = cityAt(map, world, 10 / camera.zoom);
  if (
    selectedId >= 0 &&
    id === selectedId &&
    snapshot.cities[selectedId]?.owner === 0
  ) {
    dragMode = 'dispatch';
    dragging = false;
    dispatchFrom = selectedId;
    dispatchPoint = world;
    dispatchTarget = -1;
    dispatchAmount = 0;
    requestDraw();
    return;
  }

  dragMode = 'pan';
  dragging = true;
});

canvas.addEventListener('pointermove', (event) => {
  if (dragMode === 'dispatch') {
    moved = true;
    const world = camera.screenToWorld(event.clientX, event.clientY);
    dispatchPoint = world;
    const target = cityAt(map, world, 14 / camera.zoom);
    dispatchTarget = target === dispatchFrom ? -1 : target;
    const current = snapshot?.cities[selectedId];
    const sliderValue = Number(panelRefs?.amountSlider?.value);
    dispatchAmount = sliderValue || (current ? Math.max(1, Math.ceil(current.garrison / 2)) : 0);
    dispatchOdds = null;
    if (dispatchTarget >= 0 && dispatchAmount > 0) {
      const targetState = snapshot.cities[dispatchTarget];
      if (targetState.owner !== 0) {
        dispatchOdds = Math.round(
          estimateBattle(
            dispatchAmount,
            {
              level: targetState.level,
              garrison: targetState.garrison,
              terrain: map.cities[dispatchTarget].terrain,
            },
            balance,
            militaryMultiplier(),
          ).odds * 100,
        );
      }
    }
    requestDraw();
    return;
  }

  if (dragging) {
    const dx = event.clientX - lastPointerX;
    const dy = event.clientY - lastPointerY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    camera.panPixels(dx, dy);
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    requestDraw();
    return;
  }
  updateHoverAt(event.clientX, event.clientY);
});

function resetDrag() {
  dragging = false;
  dragMode = null;
  dispatchFrom = -1;
  dispatchPoint = null;
  dispatchTarget = -1;
  dispatchAmount = 0;
  dispatchOdds = null;
  canvas.classList.remove('is-dragging');
  requestDraw();
}

/** @param {number} targetId */
function dispatchTo(targetId) {
  const current = snapshot.cities[selectedId];
  if (!current || current.owner !== 0) return;
  if (current.garrison <= 0) {
    showToast('该城没有可派出的部队');
    return;
  }
  const source = map.cities[selectedId];
  const landRoute = source.neighbors.includes(targetId);
  const seaRoute = (source.seaNeighbors ?? []).includes(targetId);
  if (!landRoute && !seaRoute) {
    showToast('只能派往相邻或可渡海的城市');
    return;
  }
  const sliderValue = Number(panelRefs?.amountSlider?.value);
  const soldiers = Math.max(
    1,
    Math.min(sliderValue || Math.ceil(current.garrison / 2), current.garrison),
  );
  const isOwn = snapshot.cities[targetId].owner === 0;
  worker.postMessage({
    type: 'command',
    command: { type: 'deploy', fromCity: selectedId, toCity: targetId, soldiers },
  });
  showToast(
    `${isOwn ? '调兵至' : '派兵前往'} ${map.cities[targetId].name}（${soldiers}）`,
  );
}

/** @param {PointerEvent} event */
function endDrag(event) {
  if (!dragMode) return;
  const mode = dragMode;
  const target = dispatchTarget;
  resetDrag();
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }

  if (mode === 'dispatch') {
    if (target >= 0) dispatchTo(target);
    return;
  }

  if (moved) return;

  const world = camera.screenToWorld(event.clientX, event.clientY);
  const id = cityAt(map, world, 12 / camera.zoom);
  if (id < 0) {
    selectedId = -1;
    hidePanel();
    requestDraw();
    return;
  }

  selectedId = id;
  renderPanel();
  requestDraw();
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', () => {
  if (dragMode) resetDrag();
});

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    camera.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
    updateHoverAt(event.clientX, event.clientY);
    requestDraw();
  },
  { passive: false },
);

canvas.addEventListener('dblclick', () => {
  camera.fit();
  requestDraw();
});

canvas.addEventListener('pointerleave', () => {
  if (hoverId < 0) return;
  hoverId = -1;
  requestDraw();
});

window.addEventListener('resize', resizeCanvas);

pauseButton.addEventListener('click', () => {
  paused = !paused;
  pauseButton.textContent = paused ? '继续' : '暂停';
  worker.postMessage({ type: paused ? 'pause' : 'resume' });
});

speedButton.addEventListener('click', () => {
  speed = speed === 1 ? 2 : 1;
  speedButton.textContent = `${speed}×`;
  worker.postMessage({ type: 'speed', speed });
});

mustElement('button-menu').addEventListener('click', () => {
  window.location.href = '/';
});

mustElement('button-home').addEventListener('click', () => {
  window.location.href = '/';
});

mustElement('button-restart').addEventListener('click', () => {
  const nextSeed = Math.floor(Math.random() * 1_000_000);
  window.location.href = `/game.html?seed=${nextSeed}&cities=${cityCount}`;
});

// Surface unexpected errors instead of silently breaking every button.
window.addEventListener('error', (event) => {
  showToast(`页面错误：${event.message || '未知错误'}`);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  showToast(`页面错误：${reason?.message ?? String(reason)}`);
});

// Lightweight debug hook used by headless smoke tests; harmless in production.
window.__warsOnPaper = {
  snapshot: () => snapshot,
  map: () => map,
  camera: () => camera,
  select: (/** @type {number} */ id) => {
    selectedId = id;
    renderPanel();
    requestDraw();
  },
  command: (/** @type {any} */ command) => {
    worker.postMessage({ type: 'command', command });
  },
};
