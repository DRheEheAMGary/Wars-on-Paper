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
let lastPointerX = 0;
let lastPointerY = 0;
let toastTimer = 0;
let drawQueued = false;

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

function renderPanel() {
  if (!snapshot || selectedId < 0 || !map.cities[selectedId]) {
    hidePanel();
    return;
  }
  const city = map.cities[selectedId];
  const cityState = snapshot.cities[selectedId];
  const player = snapshot.players[0];
  const owned = cityState.owner === 0;
  const militaryMultiplier =
    1 + (player.tech?.military ? balance.researchEffects.military : 0);

  panelElement.classList.remove('hidden');
  panelElement.replaceChildren();

  panelElement.append(
    createElement('h3', 'panel-title', city.name),
    createElement(
      'p',
      'panel-sub',
      `Lv.${cityState.level} · 人口 ${cityState.population} · 驻军 ${cityState.garrison}` +
        (owned ? '' : ' · 中立城市（点击你自己的城市才能操作）'),
    ),
  );

  if (owned) {
    const actions = createElement('div', 'panel-actions');
    const config =
      balance.cityLevels[Math.min(cityState.level, balance.cityLevels.length) - 1];

    const recruit = createElement(
      'button',
      '',
      `招募 ${balance.recruitBatch} 兵（${balance.soldierCostGold * balance.recruitBatch} 金 / ${balance.soldierCostPopulation * balance.recruitBatch} 人口）`,
    );
    recruit.addEventListener('click', () => {
      worker.postMessage({
        type: 'command',
        command: { type: 'recruit', cityId: selectedId },
      });
    });
    actions.append(recruit);

    const upgrade = createElement(
      'button',
      '',
      cityState.level >= balance.cityLevels.length
        ? '已满级'
        : `升级至 Lv.${cityState.level + 1}（${config.upgradeGold} 金）`,
    );
    upgrade.disabled = cityState.level >= balance.cityLevels.length;
    upgrade.addEventListener('click', () => {
      worker.postMessage({
        type: 'command',
        command: { type: 'upgrade', cityId: selectedId },
      });
    });
    actions.append(upgrade);
    panelElement.append(actions);

    if (cityState.upgrading) {
      const remaining = Math.max(0, cityState.upgrading.endsTick - snapshot.tick);
      panelElement.append(
        createElement('p', 'panel-sub', `升级中… 剩余 ${(remaining / 10).toFixed(0)} 秒`),
      );
    }

    panelElement.append(createElement('p', 'panel-label', '科技'));
    const researchList = createElement('div', 'research-list');
    for (const tech of balance.research ?? []) {
      const researched = Boolean(player.tech?.[tech.id]);
      const button = createElement(
        'button',
        '',
        researched
          ? `${tech.name} · 已研发`
          : `${tech.name}（${tech.description}）· ${tech.costGold} 金`,
      );
      button.disabled = researched || player.gold < tech.costGold;
      button.addEventListener('click', () => {
        worker.postMessage({
          type: 'command',
          command: { type: 'research', techId: tech.id },
        });
      });
      researchList.append(button);
    }
    panelElement.append(researchList);
  }

  panelElement.append(
    createElement('p', 'panel-label', owned ? '可行动目标' : '相邻城市'),
  );

  const list = createElement('div', 'neighbour-list');
  const targets = [...city.neighbors, ...(city.seaNeighbors ?? [])];
  for (const neighbourId of targets) {
    const neighbour = map.cities[neighbourId];
    const neighbourState = snapshot.cities[neighbourId];
    const sea = !city.neighbors.includes(neighbourId);
    const ownerText =
      neighbourState.owner === 0
        ? '你的城市'
        : neighbourState.owner === null
          ? '中立'
          : '敌方';

    const row = createElement('div', 'neighbour-row');
    row.append(
      createElement(
        'span',
        'neighbour-info',
        `${neighbour.name}${sea ? ' · 渡海' : ''} · ${ownerText} · 守军 ${neighbourState.garrison}`,
      ),
    );

    if (owned) {
      if (neighbourState.owner === 0) {
        const button = createElement('button', '', '增援');
        button.addEventListener('click', () => {
          worker.postMessage({
            type: 'command',
            command: { type: 'deploy', fromCity: selectedId, toCity: neighbourId },
          });
          showToast(`增援 ${neighbour.name}`);
        });
        row.append(button);
      } else {
        const targetInfo = {
          level: neighbourState.level,
          garrison: neighbourState.garrison,
          terrain: neighbour.terrain,
        };
        const half = Math.max(1, Math.floor(cityState.garrison / 2));
        const allOdds = Math.round(
          estimateBattle(cityState.garrison, targetInfo, balance, militaryMultiplier)
            .odds * 100,
        );
        const halfOdds = Math.round(
          estimateBattle(half, targetInfo, balance, militaryMultiplier).odds * 100,
        );
        const actions = createElement('div', 'neighbour-actions');

        const halfButton = createElement('button', '', `半 ${halfOdds}%`);
        halfButton.addEventListener('click', () => {
          worker.postMessage({
            type: 'command',
            command: {
              type: 'deploy',
              fromCity: selectedId,
              toCity: neighbourId,
              soldiers: half,
            },
          });
          showToast(`派兵前往 ${neighbour.name}`);
        });
        const allButton = createElement('button', '', `全 ${allOdds}%`);
        allButton.addEventListener('click', () => {
          worker.postMessage({
            type: 'command',
            command: { type: 'deploy', fromCity: selectedId, toCity: neighbourId },
          });
          showToast(`派兵前往 ${neighbour.name}`);
        });
        actions.append(halfButton, allButton);
        row.append(actions);
      }
    }

    list.append(row);
  }
  panelElement.append(list);
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
  dragging = true;
  moved = false;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('is-dragging');
});

canvas.addEventListener('pointermove', (event) => {
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

/** @param {PointerEvent} event */
function endDrag(event) {
  if (!dragging) return;
  dragging = false;
  canvas.classList.remove('is-dragging');
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
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

  const targetState = snapshot.cities[id];
  if (
    selectedId >= 0 &&
    selectedId !== id &&
    targetState.owner !== 0 &&
    snapshot.cities[selectedId].owner === 0 &&
    map.cities[selectedId].neighbors.includes(id)
  ) {
    worker.postMessage({
      type: 'command',
      command: { type: 'deploy', fromCity: selectedId, toCity: id },
    });
    showToast(`派兵前往 ${map.cities[id].name}`);
    return;
  }

  selectedId = id;
  renderPanel();
  requestDraw();
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

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
