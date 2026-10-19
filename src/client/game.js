// @ts-check
/**
 * Single-player match page: canvas renderer + DOM HUD, talks to the simulation
 * worker. M2 core loop (economy, recruiting, marching, combat, capture).
 */

import { Camera } from './render/camera.js';
import { drawMatch, cityAt } from './render/match.js';
import { estimateBattle } from '../shared/combat.js';
import { techEffects } from '../shared/tech.js';
import { compositionText, splitUnits } from '../shared/units.js';
import {
  buildingById,
  buildingEffects,
  buildingSlotsLeft,
} from '../shared/buildings.js';
import {
  commanderAtCity,
  commanderTraitName,
  commanderXpToNext,
} from '../shared/commanders.js';
import {
  countAllies,
  getRelation,
  isBlocked,
  relationLabel,
} from '../shared/diplomacy.js';

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
const statObjective = mustElement('stat-objective');
const standingsElement = mustElement('standings');
const resultRanking = mustElement('result-ranking');
const pauseMenu = mustElement('pause-menu');
const pauseDetail = mustElement('pause-detail');
const tutorialPanel = mustElement('tutorial-panel');
const tutorialTitle = mustElement('tutorial-title');
const tutorialDesc = mustElement('tutorial-desc');
const tutorialComplete = mustElement('tutorial-complete');
const coachElement = mustElement('coach');
const coachTitle = mustElement('coach-title');
const coachDesc = mustElement('coach-desc');
const pauseButton = mustElement('button-pause');
const speedButton = mustElement('button-speed');
const overviewElement = mustElement('overview');
const overviewTitle = mustElement('overview-title');
const overviewMeta = mustElement('overview-meta');
const overviewBody = mustElement('overview-body');
const overviewClose = mustElement('overview-close');
const overviewButton = mustElement('button-overview');

const CITY_COUNTS = new Set([60, 100, 160, 240, 360]);
const params = new URLSearchParams(window.location.search);
const requestedCities = Number(params.get('cities'));
const cityCount = CITY_COUNTS.has(requestedCities) ? requestedCities : 160;
const seed = Number(params.get('seed')) || Math.floor(Math.random() * 1_000_000);
const roomCode = params.get('room') ?? '';
const isMultiplayer = Boolean(roomCode);
const gameMode = params.get('mode') === 'endless' ? 'endless' : 'timed';

const tutorialMode = params.get('tutorial') === '1';
const coachMode =
  params.get('coach') === '1' && !isMultiplayer && !tutorialMode;

const balance = await fetch('/data/balance.json', { cache: 'no-store' }).then(
  (response) => response.json(),
);
const requestedScenario = params.get('scenario') ?? '';
const scenarioId = balance.scenarios?.[requestedScenario]
  ? requestedScenario
  : 'classic';
const effectiveScenario = tutorialMode ? 'classic' : scenarioId;

const requestedAI = Number(params.get('ai'));
const aiCount = Number.isInteger(requestedAI)
  ? Math.min(3, Math.max(0, requestedAI))
  : 2;
const requestedDifficulty = params.get('difficulty') ?? '';
const difficultyId = balance.difficulties?.[requestedDifficulty]
  ? requestedDifficulty
  : balance.defaultDifficulty ?? 'normal';
const difficulty = balance.difficulties?.[difficultyId] ?? null;
const requestedMinutes = Number(params.get('minutes'));
const matchSeconds =
  Number.isFinite(requestedMinutes) && requestedMinutes >= 3 && requestedMinutes <= 30
    ? Math.round(requestedMinutes * 60)
    : balance.matchSeconds;
const effectiveCityCount = tutorialMode ? 40 : cityCount;
const effectiveSeed = tutorialMode ? 7777 : seed;
const effectiveAICount = tutorialMode ? 0 : aiCount;
const effectiveMatchSeconds = tutorialMode ? 1800 : matchSeconds;
const effectiveMode = tutorialMode ? 'timed' : gameMode;
const startQuery = new URLSearchParams({
  seed: String(seed),
  cities: String(cityCount),
  ai: String(aiCount),
  difficulty: difficultyId,
  minutes: String(Math.round(matchSeconds / 60)),
  mode: gameMode,
  scenario: effectiveScenario,
});

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
const multiSelected = new Set();
let multiPanelSignature = '';
/** @type {{ cityId: number, type: string, started: number }[]} */
let effects = [];
let selectedStance = 'none';
let selectedOrder = 'none';
let myPlayerId = 0;
/** @type {WebSocket | null} */
let ws = null;
/** @type {Worker | null} */
let worker = null;
let reconnectTimer = 0;
let tutorialStep = 0;
let tutorialDone = false;
let overviewOpen = false;
let overviewFilter = 'mine';
let overviewLastRender = 0;
let coachStep = 0;
let coachDismissed = false;
let coachStartUnits = null;
let coachStartCities = null;
let autoSelected = false;
let advancedOpen = false;

const TUTORIAL_STEPS = [
  {
    title: '选中城市',
    description: '单击地图上属于你的城市（红色区域），打开左侧城市面板。',
    check: () =>
      selectedId >= 0 &&
      Boolean(snapshot) &&
      snapshot.cities[selectedId]?.owner === myPlayerId,
  },
  {
    title: '招募部队',
    description: '在面板中点击「招募步兵 ×10」。',
    check: () => {
      if (!snapshot) return false;
      let total = 0;
      for (const city of snapshot.cities) {
        if (city.owner !== myPlayerId) continue;
        total += city.units?.infantry ?? city.garrison ?? 0;
      }
      return total > 180;
    },
  },
  {
    title: '切换姿态',
    description: '在「行军姿态」里选择「突击」，体验攻击加成。',
    check: () => selectedStance !== 'none',
  },
  {
    title: '招募将领',
    description: '点击「招募将领」雇佣一名新将领。',
    check: () => {
      const player = snapshot?.players?.[myPlayerId];
      return Boolean(player) && (player.commanders ?? []).length > 1;
    },
  },
  {
    title: '建造建筑',
    description: '在「建筑」里建造市集、粮仓、兵营或城墙。',
    check: () =>
      Boolean(snapshot) &&
      snapshot.cities.some(
        (city) => city.owner === myPlayerId && (city.buildings ?? []).length > 0,
      ),
  },
  {
    title: '研发科技',
    description: '在「科技」里研发一项科技（需要等待研发倒计时）。',
    check: () => {
      const player = snapshot?.players?.[myPlayerId];
      if (!player) return false;
      return Boolean(player.research) || Object.keys(player.tech ?? {}).length > 0;
    },
  },
  {
    title: '占领城市',
    description: '调好「派兵数量」，从选中城市拖到相邻中立城市，占领它。',
    check: () => {
      const player = snapshot?.players?.[myPlayerId];
      return Boolean(player) && player.cityCount > 3;
    },
  },
];

function updateTutorial() {
  if (!tutorialMode || tutorialDone || !snapshot) return;
  while (
    tutorialStep < TUTORIAL_STEPS.length &&
    TUTORIAL_STEPS[tutorialStep].check()
  ) {
    tutorialStep += 1;
  }
  if (tutorialStep >= TUTORIAL_STEPS.length) {
    tutorialDone = true;
    tutorialPanel.classList.add('hidden');
    tutorialComplete.classList.remove('hidden');
    send({ type: 'pause' });
    return;
  }
  const step = TUTORIAL_STEPS[tutorialStep];
  tutorialPanel.classList.remove('hidden');
  tutorialTitle.textContent = `${tutorialStep + 1}/${TUTORIAL_STEPS.length} · ${step.title}`;
  tutorialDesc.textContent = step.description;
}

/** @param {any} message */
function send(message) {
  if (isMultiplayer) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    return;
  }
  worker?.postMessage(message);
}

function applySnapshot(nextSnapshot) {
  snapshot = nextSnapshot;
  updateHud();
  handleEvents(snapshot.events ?? []);
  if (
    !autoSelected &&
    !tutorialMode &&
    myPlayerId >= 0 &&
    selectedId < 0 &&
    Array.isArray(snapshot.players)
  ) {
    const ownCity = snapshot.cities.find((city) => city.owner === myPlayerId);
    if (ownCity) {
      autoSelected = true;
      selectedId = ownCity.id;
    }
  }
  if (selectedId >= 0) renderPanel();
  if (snapshot.phase !== 'playing') showResult();
  updateTutorial();
  updateCoach();
  if (overviewOpen) {
    const now = performance.now();
    if (now - overviewLastRender > 1200) {
      overviewLastRender = now;
      renderOverview();
    }
  }
  requestDraw();
}

/** @param {any} message */
function handleServerMessage(message) {
  if (message.type === 'welcome') {
    sessionStorage.setItem('wop-token', message.token);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'join', code: roomCode }));
    }
    return;
  }
  if (message.type === 'started') {
    map = message.map;
    myPlayerId = message.playerId ?? -1;
    camera = new Camera(map.width, map.height);
    resizeCanvas();
    applySnapshot(message.snapshot);
    return;
  }
  if (message.type === 'snapshot') {
    if (!map) return;
    applySnapshot(message.snapshot);
    return;
  }
  if (message.type === 'error') {
    showToast(message.message ?? '连接出错');
    return;
  }
  if (message.type === 'left' || message.type === 'room-closed') {
    showToast('已离开房间');
    window.setTimeout(() => {
      window.location.href = '/multiplayer.html';
    }, 1200);
  }
}

function leaveMultiplayer(nextUrl) {
  if (!isMultiplayer) {
    window.location.href = nextUrl;
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'leave' }));
  }
  window.setTimeout(() => {
    window.location.href = nextUrl;
  }, 150);
}

function connectMultiplayer() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  ws.addEventListener('open', () => {
    ws?.send(
      JSON.stringify({
        type: 'hello',
        token: sessionStorage.getItem('wop-token') ?? '',
        name: localStorage.getItem('wop-name') ?? '指挥官',
      }),
    );
    showToast(snapshot ? '已重新连接' : '已连接房间，等待开始…');
  });
  ws.addEventListener('message', (event) => {
    try {
      handleServerMessage(JSON.parse(event.data));
    } catch {
      // ignore malformed frames
    }
  });
  ws.addEventListener('close', () => {
    if (snapshot?.phase === 'ended') return;
    showToast('连接断开，正在重连…');
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connectMultiplayer, 1500);
  });
  ws.addEventListener('error', () => {});
}

if (isMultiplayer) {
  pauseButton.style.display = 'none';
  speedButton.style.display = 'none';
  mustElement('button-menu').textContent = '退出';
  mustElement('button-restart').textContent = '返回大厅';
  mustElement('button-result-settings').style.display = 'none';
  connectMultiplayer();
} else {
  worker = new Worker('/src/client/game-worker.js', { type: 'module' });
  worker.onerror = (event) => {
    showToast(`模拟器启动失败：${event.message || '未知错误'}`);
  };
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
    if (message.type === 'snapshot') applySnapshot(message.snapshot);
  };
  send({
    type: 'init',
    config: {
      seed: effectiveSeed,
      cityCount: effectiveCityCount,
      aiCount: effectiveAICount,
      matchSeconds: effectiveMatchSeconds,
      aiProfile: difficulty,
      mode: effectiveMode,
      scenario: effectiveScenario,
      tutorial: tutorialMode,
    },
    balance,
  });
}

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


function svgIcon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${id}`);
  svg.append(use);
  return svg;
}

function overviewSummaryCard(label, value, iconId, suffix = '') {
  const card = createElement('div', 'overview-card');
  card.append(createElement('span', 'overview-card-label', label));
  const valueElement = createElement('span', 'overview-card-value');
  if (iconId) valueElement.append(svgIcon(iconId));
  valueElement.append(document.createTextNode(value));
  if (suffix) valueElement.append(createElement('small', '', ` ${suffix}`));
  card.append(valueElement);
  return card;
}

function overviewSection(title) {
  const section = createElement('section', 'overview-section');
  section.append(createElement('h3', '', title));
  return section;
}

function overviewListItem(left, right = '') {
  const item = document.createElement('li');
  item.append(createElement('span', '', left));
  if (right) item.append(createElement('b', '', right));
  return item;
}

function formatClock(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = String(safe % 60).padStart(2, '0');
  return `${minutes}:${rest}`;
}

function cityDisplayName(cityId) {
  return map?.cities?.[cityId]?.name ?? `城 ${cityId + 1}`;
}

function buildingDisplayName(id) {
  const building = Object.values(balance.buildings ?? {}).find(
    (entry) => entry.id === id,
  );
  return building?.name ?? id;
}

function focusDisplayName(focusId) {
  return balance.cityFocus?.[focusId]?.name ?? focusId ?? '';
}

function specialDisplayName(type) {
  return balance.specialSites?.[type]?.name ?? type ?? '';
}

function relationStatusLabel(status) {
  if (status === 'ally') return '结盟';
  if (status === 'peace') return '停战';
  if (status === 'war') return '敌对';
  if (status === 'betrayed') return '背叛中';
  return '中立';
}

function relationBetween(stateSnapshot, a, b) {
  const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
  return stateSnapshot.diplomacy?.[key]?.status ?? 'neutral';
}

function renderOverview() {
  if (!snapshot) return;
  const playerId = myPlayerId >= 0 ? myPlayerId : 0;
  const player = snapshot.players[playerId] ?? snapshot.players[0];
  if (!player) return;
  const cities = snapshot.cities ?? [];
  const ownCities = cities.filter((city) => city.owner === playerId);
  const specialSites = snapshot.specialSites ?? [];
  const ownedSpecial = specialSites.filter(
    (site) => cities[site.cityId]?.owner === playerId,
  ).length;
  const specialRequired = snapshot.specialRequired ?? 0;
  const researched = Object.keys(player.tech ?? {}).length;
  const techTotal = Object.keys(balance.research ?? {}).length;
  const playersById = new Map(snapshot.players.map((entry) => [entry.id, entry]));

  overviewTitle.textContent = `${player.name} · ${
    isMultiplayer ? '多人对局总览' : '国家总览'
  }`;
  const timeLabel =
    snapshot.mode === 'endless'
      ? `第 ${snapshot.wave ?? 0} 波`
      : `剩余 ${formatClock(
          (snapshot.matchSeconds ?? 0) - (snapshot.tick ?? 0) * 0.1,
        )}`;
  overviewMeta.textContent = `实时 · ${timeLabel}`;

  overviewBody.replaceChildren();

  const summary = createElement('div', 'overview-summary');
  summary.append(
    overviewSummaryCard('金币', Math.floor(player.gold).toLocaleString(), 'gold'),
    overviewSummaryCard('粮食', Math.floor(player.food).toLocaleString(), 'food'),
    overviewSummaryCard('城市', `${ownCities.length}`, 'cities', `/ ${cities.length}`),
    overviewSummaryCard('分数', player.score.toLocaleString(), 'score'),
    overviewSummaryCard('歼敌', `${Math.round(player.kills ?? 0)}`, 'army'),
    overviewSummaryCard('科技', `${researched}`, 'tech', `/ ${techTotal}`),
    overviewSummaryCard(
      '将领',
      `${(player.commanders ?? []).length}`,
      'commander',
    ),
    overviewSummaryCard(
      '战略目标',
      `${ownedSpecial}`,
      'flag',
      `/ ${specialRequired}`,
    ),
  );
  overviewBody.append(summary);

  const columns = createElement('div', 'overview-columns');

  // Research / tech panel
  const techSection = overviewSection('科技与研发');
  const techList = createElement('ul', 'overview-list');
  if (player.research) {
    const current = Object.values(balance.research ?? {}).find(
      (entry) => entry.id === player.research.id,
    );
    const remaining = Math.max(
      0,
      Math.ceil((player.research.endsTick - snapshot.tick) / 10),
    );
    techList.append(
      overviewListItem(`研发中：${current?.name ?? player.research.id}`, `${remaining}s`),
    );
  } else {
    techList.append(overviewListItem('当前没有进行中的研发', ''));
  }
  for (const tech of Object.values(balance.research ?? {})) {
    const isDone = Boolean(player.tech?.[tech.id]);
    techList.append(
      overviewListItem(
        `${tech.name} · ${tech.description ?? ''}`,
        isDone ? '已研发' : '未研发',
      ),
    );
  }
  techSection.append(techList);
  columns.append(techSection);

  // Commander panel
  const commanderSection = overviewSection('将领');
  const commanderList = createElement('ul', 'overview-list');
  for (const commander of player.commanders ?? []) {
    const city = commander.cityId === null ? '未派驻' : cityDisplayName(commander.cityId);
    commanderList.append(
      overviewListItem(
        `${commander.name} · ${commanderTraitName(balance, commander.trait)} Lv.${commander.level}`,
        city,
      ),
    );
  }
  if ((player.commanders ?? []).length === 0) {
    commanderList.append(createElement('li', 'muted', '暂无将领'));
  }
  commanderSection.append(commanderList);
  columns.append(commanderSection);

  // Objective / special sites
  const objectiveSection = overviewSection('战略据点');
  const objectiveList = createElement('ul', 'overview-list');
  for (const site of specialSites) {
    const city = cities[site.cityId];
    const owner =
      city?.owner === null || city?.owner === undefined
        ? '中立'
        : city.owner === playerId
          ? '我方'
          : playersById.get(city.owner)?.name ?? `玩家 ${city.owner}`;
    objectiveList.append(
      overviewListItem(
        `${specialDisplayName(site.type)} · ${cityDisplayName(site.cityId)}`,
        owner,
      ),
    );
  }
  if (specialSites.length === 0) {
    objectiveList.append(createElement('li', 'muted', '本图没有战略据点'));
  }
  objectiveSection.append(objectiveList);
  columns.append(objectiveSection);

  // Diplomacy + events
  const infoSection = overviewSection('外交与事件');
  const infoList = createElement('ul', 'overview-list');
  for (const other of snapshot.players) {
    if (other.id === playerId) continue;
    const status = relationBetween(snapshot, playerId, other.id);
    infoList.append(
      overviewListItem(`${other.name}${other.isAI ? ' · AI' : ''}`, relationStatusLabel(status)),
    );
  }
  const recentEvents = (snapshot.events ?? []).slice(-4).reverse();
  const eventNames = {
    captured: '占领城市',
    battle: '战斗',
    worldEvent: '世界事件',
    coalition: '反制联盟',
    wave: '叛军来袭',
    upgraded: '城市升级',
    starvation: '饥荒',
    diplomacy: '外交变化',
  };
  for (const event of recentEvents) {
    const name = event.name ?? eventNames[event.type] ?? event.type;
    const detail = event.description ?? event.cityName ?? '';
    infoList.append(overviewListItem(`事件：${name}`, detail));
  }
  if (infoList.children.length === 0) {
    infoList.append(createElement('li', 'muted', '暂无信息'));
  }
  infoSection.append(infoList);
  columns.append(infoSection);

  overviewBody.append(columns);

  // Cities table
  const toolbar = createElement('div', 'overview-toolbar');
  toolbar.append(createElement('h3', '', '城市状态'));
  const filters = createElement('div', 'overview-filters');
  const filterOptions = [
    ['mine', '我的城市'],
    ['all', '全部城市'],
    ['special', '战略据点'],
    ['enemy', '敌方城市'],
  ];
  for (const [filterId, label] of filterOptions) {
    const button = createElement('button', 'overview-filter', label);
    button.type = 'button';
    if (overviewFilter === filterId) button.classList.add('is-active');
    button.addEventListener('click', () => {
      overviewFilter = filterId;
      renderOverview();
    });
    filters.append(button);
  }
  toolbar.append(filters);
  overviewBody.append(toolbar);

  let visibleCities = cities;
  if (overviewFilter === 'mine') {
    visibleCities = cities.filter((city) => city.owner === playerId);
  } else if (overviewFilter === 'enemy') {
    visibleCities = cities.filter(
      (city) => city.owner !== null && city.owner !== playerId,
    );
  } else if (overviewFilter === 'special') {
    visibleCities = cities.filter((city) => city.special);
  }
  visibleCities = [...visibleCities].sort((a, b) => {
    const rank = (city) =>
      city.owner === playerId ? 0 : city.owner === null ? 2 : 1;
    return rank(a) - rank(b) || b.garrison - a.garrison || a.id - b.id;
  });

  const tableWrap = createElement('div', 'overview-table-wrap');
  const table = createElement('table', 'overview-table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of [
    '城市',
    '归属',
    'Lv',
    '驻军',
    '兵种',
    '专精',
    '据点',
    '建筑',
    '将领',
  ]) {
    headRow.append(createElement('th', '', label));
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const city of visibleCities) {
    const row = document.createElement('tr');
    if (city.owner === playerId) row.classList.add('is-mine');
    const owner =
      city.owner === null
        ? { name: '中立', color: '#b5b5b5' }
        : playersById.get(city.owner) ?? {
            name: `玩家 ${city.owner}`,
            color: '#6f6f6f',
          };
    const nameCell = document.createElement('td');
    nameCell.textContent = cityDisplayName(city.id);
    if (city.special) {
      const badge = createElement(
        'span',
        'owner-dot',
      );
      badge.style.background = '#b08a2e';
      nameCell.prepend(badge);
    }
    const ownerCell = document.createElement('td');
    const dot = createElement('span', 'owner-dot');
    dot.style.background = owner.color ?? '#6f6f6f';
    ownerCell.append(dot, document.createTextNode(owner.name));
    const units = city.units ?? {};
    const commander = (playersById.get(city.owner)?.commanders ?? []).find(
      (entry) => entry.id === city.commanderId,
    );
    const cells = [
      nameCell,
      ownerCell,
      String(city.level),
      String(city.garrison),
      `步 ${units.infantry ?? 0} · 骑 ${units.cavalry ?? 0} · 械 ${units.siege ?? 0}`,
      city.focus ? focusDisplayName(city.focus) : '—',
      city.special ? specialDisplayName(city.special) : '—',
      (city.buildings ?? []).map(buildingDisplayName).join('、') || '—',
      commander?.name ?? '—',
    ];
    for (const [index, value] of cells.entries()) {
      if (index === 0 || index === 1) {
        row.append(value);
      } else {
        const cell = createElement('td', '', value);
        if (value === '—') cell.classList.add('muted');
        row.append(cell);
      }
    }
    row.addEventListener('click', () => {
      toggleOverview(false);
      multiSelected.clear();
      multiPanelSignature = '';
      selectedId = city.id;
      renderPanel();
      requestDraw();
    });
    body.append(row);
  }
  table.append(head, body);
  tableWrap.append(table);
  overviewBody.append(tableWrap);

  if (visibleCities.length === 0) {
    overviewBody.append(createElement('p', 'overview-empty', '这个分类下暂时没有城市。'));
  }
}

function toggleOverview(force) {
  const next = typeof force === 'boolean' ? force : !overviewOpen;
  overviewOpen = next;
  overviewElement.classList.toggle('hidden', !next);
  overviewElement.setAttribute('aria-hidden', String(!next));
  if (next) {
    overviewLastRender = performance.now();
    renderOverview();
    overviewClose.focus({ preventScroll: true });
  } else {
    overviewButton.focus({ preventScroll: true });
  }
}

function updateHud() {
  if (!snapshot) return;
  const player =
    snapshot.players[myPlayerId] ??
    snapshot.players[0] ??
    { gold: 0, food: 0, cityCount: 0, score: 0 };
  statGold.textContent = String(Math.floor(player.gold));
  statFood.textContent = String(Math.floor(player.food));
  statCities.textContent = String(player.cityCount);
  statScore.textContent = String(player.score);
  if (snapshot.specialRequired > 0) {
    const owned = snapshot.cities.filter(
      (/** @type {any} */ city) => city.special && city.owner === myPlayerId,
    ).length;
    statObjective.textContent = `目标 ${owned}/${snapshot.specialRequired}`;
  } else {
    statObjective.textContent = '';
  }
  if (snapshot.mode === 'endless') {
    const nextIn = Math.max(
      0,
      Math.round((snapshot.nextWaveTick - snapshot.tick) / 10),
    );
    statTimer.textContent = `第 ${snapshot.wave ?? 0} 波 · 下一波 ${nextIn}s`;
  } else {
    const elapsed = Math.floor((snapshot.tick * balance.tickMs) / 1000);
    const remaining = Math.max(0, (snapshot.matchSeconds ?? balance.matchSeconds) - elapsed);
    const minutes = Math.floor(remaining / 60);
    const seconds = String(remaining % 60).padStart(2, '0');
    statTimer.textContent = `${minutes}:${seconds}`;
  }

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
  const now = performance.now();
  for (const event of events) {
    if (event.type === 'captured' || event.type === 'battle') {
      effects.push({
        cityId: event.cityId,
        type: event.type === 'captured' ? 'capture' : 'battle',
        started: now,
      });
    }
    if (event.type === 'captured') {
      showToast(`占领 ${map.cities[event.cityId]?.name ?? '城市'}`);
    } else if (event.type === 'battle') {
      const name = map.cities[event.cityId]?.name ?? '城市';
      showToast(
        `${name} 战斗：损失 ${event.attackerLoss}，歼敌 ${event.defenderLoss}`,
      );
    } else if (event.type === 'wave') {
      showToast(`第 ${event.wave} 波叛军从边境来袭`);
    } else if (event.type === 'rebelCapture') {
      showToast(`叛军攻占 ${map.cities[event.cityId]?.name ?? '一座城市'}`);
    } else if (event.type === 'worldEvent') {
      showToast(`【${event.name}】${event.description}`);
    } else if (event.type === 'coalition') {
      showToast('AI 结成反制联盟，共同对抗领先者');
    } else if (event.type === 'diplomacy') {
      if (event.a === myPlayerId || event.b === myPlayerId) {
        const otherId = event.a === myPlayerId ? event.b : event.a;
        const otherName = map ? snapshot?.players?.[otherId]?.name : '玩家';
        if (event.kind === 'break') showToast(`你与 ${otherName} 断盟`);
        else showToast(`${event.kind === 'ally' ? '结盟' : '停战'}达成：${otherName}`);
      }
    } else if (event.type === 'diplomacyRequest') {
      if (event.to === myPlayerId) {
        const fromName = snapshot?.players?.[event.from]?.name ?? '玩家';
        showToast(`${fromName} 请求${event.kind === 'ally' ? '结盟' : '停战'}`);
      }
    } else if (event.type === 'researched') {
      showToast(`${event.name ?? '科技'} 研发完成`);
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

function playerTech(playerId) {
  const player = snapshot?.players?.[playerId];
  return techEffects(player ?? {}, balance);
}

function renderPanel() {
  if (!snapshot || selectedId < 0 || !map.cities[selectedId]) {
    hidePanel();
    return;
  }
  if (multiSelected.size > 1) {
    const signature = [...multiSelected].sort((a, b) => a - b).join(',');
    if (!panelRefs?.multi || multiPanelSignature !== signature) {
      multiPanelSignature = signature;
      buildMultiPanel();
    } else {
      updateMultiPanel();
    }
    return;
  }
  multiPanelSignature = '';
  if (panelRefs?.multi) {
    panelRefs = null;
    panelCityId = -1;
  }
  const cityState = snapshot.cities[selectedId];
  const owned = cityState.owner === myPlayerId;
  // Rebuild only when the selected city or its ownership changes; snapshots
  // otherwise update values in place so clicks are never swallowed by a rebuild.
  if (!panelRefs || panelCityId !== selectedId || panelRefs.owned !== owned) {
    buildPanel();
  } else {
    updatePanel();
  }
}

function updateStanceButtons() {
  if (!panelRefs?.stanceButtons) return;
  for (const [stanceId, button] of panelRefs.stanceButtons) {
    button.classList.toggle('is-active', stanceId === selectedStance);
  }
}

function updateOrderButtons() {
  if (!panelRefs?.orderButtons) return;
  for (const [orderId, button] of panelRefs.orderButtons) {
    button.classList.toggle('is-active', orderId === selectedOrder);
  }
}

function estimateDeployOdds(fromCityState, targetState, soldiers) {
  const sent = splitUnits(
    fromCityState.units ?? { infantry: fromCityState.garrison ?? 0 },
    soldiers,
  ).taken;
  const attackerTech = playerTech(myPlayerId);
  const defenderTech =
    targetState.owner === null ? {} : playerTech(targetState.owner);
  const defenderBuildings = buildingEffects(balance, {
    buildings: targetState.buildings ?? [],
  });
  return Math.round(
    estimateBattle(
      sent,
      {
        level: targetState.level,
        garrison: targetState.garrison,
        units: targetState.units,
        terrain: map.cities[targetState.id].terrain,
      },
      balance,
      {
        attackerAttack: attackerTech.attack,
        defenderDefense:
          (defenderTech.defense ?? 0) + (defenderBuildings.defense ?? 0),
        siegeBonus: attackerTech.siege,
      },
    ).odds * 100,
  );
}

function buildMultiPanel() {
  const ids = [...multiSelected].filter(
    (id) => snapshot.cities[id]?.owner === myPlayerId,
  );
  if (ids.length <= 1) {
    multiSelected.clear();
    renderPanel();
    return;
  }
  panelElement.classList.remove('hidden', 'beginner', 'show-advanced');
  panelElement.replaceChildren();
  panelCityId = selectedId;
  panelRefs = {
    multi: true,
    ids,
    rows: new Map(),
    unitButtons: new Map(),
    upgrade: null,
    sub: null,
  };

  panelElement.append(
    createElement('h3', 'panel-title', `已选 ${ids.length} 座城市`),
    (panelRefs.sub = createElement('p', 'panel-sub', '')),
  );

  const list = createElement('div', 'multi-city-list');
  for (const id of ids) {
    const city = map.cities[id];
    const state = snapshot.cities[id];
    const row = createElement('div', 'multi-city-row');
    const text = createElement('span', '', `${city?.name ?? `城 ${id + 1}`} · Lv.${state.level}`);
    const garrison = createElement('small', '', `驻军 ${state.garrison}`);
    row.append(text, garrison);
    list.append(row);
    panelRefs.rows.set(id, { row, garrison });
  }
  panelElement.append(list);

  panelElement.append(createElement('p', 'panel-label', '批量操作'));
  const actions = createElement('div', 'panel-actions multi-actions');
  const player = snapshot.players[myPlayerId] ?? {};
  for (const unitType of balance.unitOrder ?? ['infantry']) {
    const unit = balance.units[unitType];
    const batch = unit.batch;
    const totalGold = unit.costGold * batch * ids.length;
    const button = createElement('button', '', `全部招募${unit.name} ×${batch}`);
    button.title = `每城 ${unit.costGold * batch} 金，共 ${totalGold} 金`;
    button.addEventListener('click', () => {
      for (const id of ids) {
        send({ type: 'command', command: { type: 'recruit', cityId: id, unitType } });
      }
    });
    panelRefs.unitButtons.set(unitType, { button, totalGold });
    actions.append(button);
  }
  const upgrade = createElement('button', '', '全部升级');
  upgrade.addEventListener('click', () => {
    for (const id of ids) {
      send({ type: 'command', command: { type: 'upgrade', cityId: id } });
    }
  });
  panelRefs.upgrade = upgrade;
  actions.append(upgrade);
  const cancel = createElement('button', '', '取消多选');
  cancel.addEventListener('click', () => {
    multiSelected.clear();
    renderPanel();
    requestDraw();
  });
  actions.append(cancel);
  panelElement.append(actions);

  panelElement.append(createElement('p', 'panel-label', '统一调动'));
  const moveTargets = snapshot.cities.filter(
    (city) => city.owner === myPlayerId && !multiSelected.has(city.id),
  );
  if (moveTargets.length > 0) {
    const moveRow = createElement('div', 'multi-move');
    const targetSelect = document.createElement('select');
    targetSelect.className = 'multi-select';
    for (const city of moveTargets) {
      const option = document.createElement('option');
      option.value = String(city.id);
      option.textContent = `${map.cities[city.id]?.name ?? `城 ${city.id + 1}`} · 驻军 ${city.garrison}`;
      targetSelect.append(option);
    }
    const ratioSelect = document.createElement('select');
    ratioSelect.className = 'multi-select multi-ratio';
    for (const ratio of [25, 50, 75, 100]) {
      const option = document.createElement('option');
      option.value = String(ratio);
      option.textContent = `${ratio}%`;
      if (ratio === 75) option.selected = true;
      ratioSelect.append(option);
    }
    const moveButton = createElement('button', '', '调动');
    moveButton.addEventListener('click', () => {
      const targetId = Number(targetSelect.value);
      const ratio = Number(ratioSelect.value) / 100;
      for (const id of ids) {
        const city = snapshot.cities[id];
        const soldiers = Math.max(1, Math.floor(city.garrison * ratio));
        send({
          type: 'command',
          command: {
            type: 'deploy',
            fromCity: id,
            toCity: targetId,
            soldiers,
            stance: selectedStance,
            order: selectedOrder,
          },
        });
      }
      showToast(`已调动 ${ids.length} 座城市的兵力`);
    });
    moveRow.append(targetSelect, ratioSelect, moveButton);
    panelElement.append(moveRow);
  } else {
    panelElement.append(
      createElement('p', 'quick-hint', '没有其他己方城市可作为调动目标。'),
    );
  }

  updateMultiPanel();
}

function updateMultiPanel() {
  if (!panelRefs?.multi || !snapshot) return;
  const ids = panelRefs.ids.filter(
    (id) => snapshot.cities[id]?.owner === myPlayerId,
  );
  if (ids.length <= 1) {
    multiSelected.clear();
    renderPanel();
    return;
  }
  const player = snapshot.players[myPlayerId] ?? {};
  let totalGarrison = 0;
  for (const id of ids) {
    const city = snapshot.cities[id];
    totalGarrison += city.garrison;
    const entry = panelRefs.rows.get(id);
    if (entry) entry.garrison.textContent = `驻军 ${city.garrison}`;
  }
  if (panelRefs.sub) {
    panelRefs.sub.textContent = `总驻军 ${totalGarrison} · 按住 Shift 继续加选/取消 · 每城默认 ×10 部队`;
  }
  for (const [, entry] of panelRefs.unitButtons ?? []) {
    entry.button.disabled = (player.gold ?? 0) < entry.totalGold;
  }
}

function buildPanel() {
  const city = map.cities[selectedId];
  const cityState = snapshot.cities[selectedId];
  const owned = cityState.owner === myPlayerId;
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

    panelRefs.recruits = new Map();
    for (const unitType of balance.unitOrder ?? ['infantry']) {
      const button = createElement('button', '');
      button.addEventListener('click', () => {
        send({
          type: 'command',
          command: { type: 'recruit', cityId: selectedId, unitType },
        });
      });
      actions.append(button);
      panelRefs.recruits.set(unitType, button);
    }

    panelRefs.upgrade = createElement('button', '');
    panelRefs.upgrade.addEventListener('click', () => {
      send({
        type: 'command',
        command: { type: 'upgrade', cityId: selectedId },
      });
    });
    actions.append(panelRefs.upgrade);
    panelElement.append(actions);

    panelRefs.upgradeInfo = createElement('p', 'panel-sub', '');
    panelElement.append(panelRefs.upgradeInfo);

    const cityMeta = map.cities[selectedId];
    const neighborIds = [
      ...(cityMeta.neighbors ?? []),
      ...(cityMeta.seaNeighbors ?? []),
    ];
    const quickTargets = neighborIds
      .map((id) => snapshot.cities[id])
      .filter((target) => target && target.owner !== myPlayerId)
      .map((target) => ({
        target,
        odds: estimateDeployOdds(
          cityState,
          target,
          Math.max(10, Math.floor(cityState.garrison * 0.75)),
        ),
      }))
      .sort((a, b) => b.odds - a.odds)
      .slice(0, 4);
    panelElement.append(createElement('p', 'panel-label', '快捷进攻'));
    if (quickTargets.length > 0) {
      panelElement.append(
        createElement(
          'p',
          'quick-hint',
          '点「进攻」直接派兵，不用拖拽；默认出兵约 75% 驻军。',
        ),
      );
      const quickList = createElement('div', 'quick-targets');
      for (const { target, odds } of quickTargets) {
        const row = createElement('div', 'quick-target');
        const info = createElement('div', 'quick-target-info');
        const ownerName =
          target.owner === null
            ? '中立'
            : snapshot.players[target.owner]?.name ?? `玩家 ${target.owner}`;
        info.append(
          createElement(
            'span',
            '',
            `${map.cities[target.id]?.name ?? `城 ${target.id + 1}`} · ${ownerName}`,
          ),
          createElement('small', '', `预计胜率 ${odds}% · 相邻`),
        );
        const button = createElement('button', '', '进攻');
        button.addEventListener('click', () => {
          send({
            type: 'command',
            command: {
              type: 'deploy',
              fromCity: selectedId,
              toCity: target.id,
              soldiers: Math.max(10, Math.floor(cityState.garrison * 0.75)),
              stance: selectedStance,
              order: selectedOrder,
            },
          });
        });
        row.append(info, button);
        quickList.append(row);
      }
      panelElement.append(quickList);
    } else {
      panelElement.append(
        createElement('p', 'quick-hint', '相邻城市都已是你的领土，可以继续扩张或进攻更远目标。'),
      );
    }

  if (owned) {
    panelElement.append(createElement('p', 'panel-label', '将领'));
    panelRefs.commanderInfo = createElement('p', 'panel-sub', '');
    panelElement.append(panelRefs.commanderInfo);
    panelRefs.commanderList = createElement('div', 'commander-list');
    panelElement.append(panelRefs.commanderList);
    panelRefs.commanderSignature = '';
    panelRefs.hireCommander = createElement('button', '');
    panelRefs.hireCommander.addEventListener('click', () => {
      send({ type: 'command', command: { type: 'hireCommander' } });
    });
    panelElement.append(panelRefs.hireCommander);

    panelElement.append(createElement('p', 'panel-label', '行军姿态'));
    const stanceRow = createElement('div', 'stance-row');
    panelRefs.stanceButtons = new Map();
    for (const [stanceId, stance] of Object.entries(balance.stances ?? {})) {
      const button = createElement('button', '', stance.name);
      button.title = stance.description ?? '';
      button.addEventListener('click', () => {
        selectedStance = stanceId;
        updateStanceButtons();
      });
      stanceRow.append(button);
      panelRefs.stanceButtons.set(stanceId, button);
    }
    panelElement.append(stanceRow);

    panelElement.append(createElement('p', 'panel-label', '战场指令'));
    const orderRow = createElement('div', 'stance-row order-row');
    panelRefs.orderButtons = new Map();
    for (const [orderId, order] of Object.entries(balance.battleOrders ?? {})) {
      const button = createElement('button', '', order.name);
      button.title = order.description ?? '';
      button.addEventListener('click', () => {
        selectedOrder = orderId;
        updateOrderButtons();
      });
      orderRow.append(button);
      panelRefs.orderButtons.set(orderId, button);
    }
    panelElement.append(orderRow);

    panelElement.append(createElement('p', 'panel-label', '城市专精'));
    const focusRow = createElement('div', 'stance-row focus-row');
    panelRefs.focusButtons = new Map();
    for (const [focusId, focus] of Object.entries(balance.cityFocus ?? {})) {
      const button = createElement('button', '', focus.name);
      button.title = focus.description ?? '';
      button.addEventListener('click', () => {
        send({
          type: 'command',
          command: { type: 'specialize', cityId: selectedId, focus: focusId },
        });
      });
      focusRow.append(button);
      panelRefs.focusButtons.set(focusId, button);
    }
    panelElement.append(focusRow);

    panelElement.append(createElement('p', 'panel-label', '派兵数量'));
    const dispatch = createElement('div', 'dispatch dispatch-amount');

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'dispatch-range';
    slider.min = '1';
    const garrison = cityState.garrison;
    slider.max = String(Math.max(1, garrison));
    slider.value = String(Math.max(1, Math.floor(garrison * 0.75)));
    panelRefs.amountRatio = 0.75;
    const count = createElement(
      'span',
      'dispatch-count',
      `${slider.value}（75%）`,
    );
    slider.addEventListener('input', () => {
      const total = Math.max(1, cityState.garrison);
      panelRefs.amountRatio = Math.min(
        1,
        Math.max(0, Number(slider.value) / total),
      );
      count.textContent = `${slider.value}（${Math.round(panelRefs.amountRatio * 100)}%）`;
    });

    dispatch.append(slider, count);
    panelElement.append(dispatch);
    panelElement.append(
      createElement(
        'p',
        'panel-sub',
        '按住已选中的城市拖到目标：自己的城市可跨任意距离调兵；攻击其他城市仅限相邻或渡海。',
      ),
    );
    panelRefs.amountSlider = slider;
    panelRefs.amountCount = count;
  } else {
    panelElement.append(
      createElement('p', 'panel-sub', '点击你自己的城市选中后，按住城市拖到目标城市即可派兵。'),
    );
  }


    panelElement.append(createElement('p', 'panel-label', '建筑'));
    panelRefs.buildingInfo = createElement('p', 'panel-sub', '');
    panelElement.append(panelRefs.buildingInfo);
    const buildingList = createElement('div', 'research-list');
    panelRefs.buildings = new Map();
    for (const building of balance.buildings ?? []) {
      const button = createElement('button', '');
      button.addEventListener('click', () => {
        send({
          type: 'command',
          command: { type: 'build', cityId: selectedId, buildingId: building.id },
        });
      });
      buildingList.append(button);
      panelRefs.buildings.set(building.id, { button, building });
    }
    panelElement.append(buildingList);

    panelElement.append(createElement('p', 'panel-label', '科技'));
    const researchList = createElement('div', 'research-list');
    for (const tech of balance.research ?? []) {
      const button = createElement('button', '');
      button.addEventListener('click', () => {
        send({
          type: 'command',
          command: { type: 'research', techId: tech.id },
        });
      });
      researchList.append(button);
      panelRefs.research.set(tech.id, { button, tech });
    }
    panelElement.append(researchList);
    panelRefs.researchInfo = createElement('p', 'panel-sub', '');
    panelElement.append(panelRefs.researchInfo);

    panelElement.append(createElement('p', 'panel-label', '外交'));
    const diplomacyList = createElement('div', 'diplomacy-list');
    panelRefs.diplomacy = new Map();
    for (const other of snapshot.players) {
      if (other.id === myPlayerId) continue;
      const row = createElement('div', 'diplomacy-row');
      const info = createElement('span', 'diplomacy-info', '');
      const actions = createElement('div', 'diplomacy-actions');
      const allyButton = createElement('button', '', '结盟');
      allyButton.addEventListener('click', () => {
        send({
          type: 'command',
          command: { type: 'diplomacy', action: 'ally', targetId: other.id },
        });
      });
      const truceButton = createElement('button', '', '停战');
      truceButton.addEventListener('click', () => {
        send({
          type: 'command',
          command: { type: 'diplomacy', action: 'truce', targetId: other.id },
        });
      });
      const breakButton = createElement('button', '', '断盟');
      breakButton.addEventListener('click', () => {
        send({
          type: 'command',
          command: { type: 'diplomacy', action: 'break', targetId: other.id },
        });
      });
      actions.append(allyButton, truceButton, breakButton);
      row.append(info, actions);
      diplomacyList.append(row);
      panelRefs.diplomacy.set(other.id, {
        info,
        allyButton,
        truceButton,
        breakButton,
        player: other,
      });
    }
    panelElement.append(diplomacyList);
    panelRefs.requestsList = createElement('div', 'diplomacy-requests');
    panelElement.append(panelRefs.requestsList);
    panelRefs.requestsSignature = '';
  }


  if (owned && coachMode) {
    const children = [...panelElement.children];
    const start = children.findIndex(
      (element) =>
        element.classList.contains('panel-label') &&
        element.textContent === '将领',
    );
    const end = children.findIndex(
      (element) =>
        element.classList.contains('panel-label') &&
        element.textContent === '派兵数量',
    );
    if (start >= 0 && end > start) {
      const advanced = createElement('div', 'panel-advanced');
      for (const element of children.slice(start, end)) {
        advanced.append(element);
      }
      panelElement.classList.add('beginner');
      panelElement.classList.toggle('show-advanced', advancedOpen);
      const toggle = createElement('button', 'advanced-toggle', '');
      const syncToggle = () => {
        toggle.textContent = advancedOpen
          ? '收起高级操作'
          : '显示高级操作（姿态 / 指令 / 专精 / 将领）';
      };
      syncToggle();
      toggle.addEventListener('click', () => {
        advancedOpen = !advancedOpen;
        panelElement.classList.toggle('show-advanced', advancedOpen);
        syncToggle();
      });
      const endNode = children[end] ?? null;
      panelElement.insertBefore(toggle, endNode);
      panelElement.insertBefore(advanced, endNode);
    }
  }

  updatePanel();
}

function updatePanel() {
  if (!panelRefs || !snapshot) return;
  const cityState = snapshot.cities[panelCityId];
  if (!cityState) return;
  const player = snapshot.players[myPlayerId] ?? snapshot.players[0] ?? {};
  const config =
    balance.cityLevels[Math.min(cityState.level, balance.cityLevels.length) - 1];

  const composition = compositionText(cityState.units ?? {}, balance);
  const special = balance.specialSites?.[cityState.special] ?? null;
  panelRefs.sub.textContent =
    `Lv.${cityState.level} · 人口 ${cityState.population} · 驻军 ${cityState.garrison}` +
    (composition ? `（${composition}）` : '') +
    (special ? ` · ${special.name}：${special.description}` : '') +
    (panelRefs.owned ? '' : ' · 中立城市（点击你自己的城市才能操作）');

  if (panelRefs.owned) {
    panelRefs.garrisonCapMultiplier =
      1 +
      buildingEffects(balance, { buildings: cityState.buildings ?? [] }).garrisonCap;
    const me = snapshot.players[myPlayerId] ?? {};
    const commanders = me.commanders ?? [];
    const assigned = commanderAtCity(me, selectedId);
    panelRefs.commanderInfo.textContent = assigned
      ? `${assigned.name} · ${commanderTraitName(balance, assigned.trait)} Lv.${assigned.level} · XP ${assigned.xp}/${commanderXpToNext(balance, assigned.level)}`
      : '暂无驻守将领（可在下方派驻）';
    const commanderSignature = commanders
      .map(
        (/** @type {any} */ commander) =>
          `${commander.id}:${commander.cityId ?? '-'}:${commander.level}`,
      )
      .join(',');
    if (commanderSignature !== panelRefs.commanderSignature) {
      panelRefs.commanderSignature = commanderSignature;
      panelRefs.commanderList.replaceChildren();
      for (const commander of commanders) {
        if (commander.cityId === selectedId) continue;
        const row = createElement('div', 'commander-row');
        const cityName =
          commander.cityId === null
            ? '未派驻'
            : map.cities[commander.cityId]?.name ?? '其它城市';
        row.append(
          createElement(
            'span',
            'commander-info',
            `${commander.name} · ${commanderTraitName(balance, commander.trait)} Lv.${commander.level} · ${cityName}`,
          ),
        );
        const assign = createElement('button', '', commander.cityId === null ? '派驻' : '调任');
        assign.addEventListener('click', () => {
          send({
            type: 'command',
            command: {
              type: 'assignCommander',
              commanderId: commander.id,
              cityId: selectedId,
            },
          });
        });
        row.append(assign);
        panelRefs.commanderList.append(row);
      }
      if (commanders.length === 0) {
        panelRefs.commanderList.append(
          createElement('p', 'panel-sub', '暂无将领，可在下方招募'),
        );
      }
    }
    const commanderConfig = balance.commanders;
    if (commanderConfig) {
      panelRefs.hireCommander.textContent = `招募将领（${commanderConfig.hireCostGold} 金）`;
      panelRefs.hireCommander.disabled =
        commanders.length >= commanderConfig.maxActive ||
        (snapshot.players[myPlayerId]?.gold ?? 0) < commanderConfig.hireCostGold;
    }

    for (const [stanceId, button] of panelRefs.stanceButtons ?? []) {
      button.classList.toggle('is-active', stanceId === selectedStance);
    }
    for (const [orderId, button] of panelRefs.orderButtons ?? []) {
      button.classList.toggle('is-active', orderId === selectedOrder);
    }
    for (const [focusId, button] of panelRefs.focusButtons ?? []) {
      button.classList.toggle('is-active', cityState.focus === focusId);
      button.disabled = Boolean(cityState.focus);
    }
    for (const [unitType, button] of panelRefs.recruits ?? []) {
      const unit = balance.units[unitType];
      const batch = unit.batch;
      const gold = unit.costGold * batch;
      const population = unit.costPopulation * batch;
      button.textContent = `招募${unit.name} ×${batch}（${gold} 金 / ${population} 人口）`;
      const capMultiplier = panelRefs.garrisonCapMultiplier ?? 1;
      button.disabled =
        player.gold < gold ||
        cityState.population < population ||
        cityState.garrison + batch > config.garrisonCap * capMultiplier;
    }

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

    const researching = player.research;
    for (const [techId, entry] of panelRefs.research) {
      const researched = Boolean(player.tech?.[techId]);
      const locked = (entry.tech.requires ?? []).some(
        (/** @type {string} */ required) => !player.tech?.[required],
      );
      const busy = Boolean(researching) && !researched;
      entry.button.textContent = researched
        ? `${entry.tech.name} · 已研发`
        : locked
          ? `${entry.tech.name} · 需前置科技`
          : `${entry.tech.name}（${entry.tech.description}）· ${entry.tech.costGold} 金`;
      entry.button.disabled =
        researched || locked || busy || player.gold < entry.tech.costGold;
    }
    if (researching) {
      const tech = balance.research.find(
        (/** @type {any} */ entry) => entry.id === researching.id,
      );
      const remaining = Math.max(0, researching.endsTick - snapshot.tick);
      panelRefs.researchInfo.textContent = `研发中：${tech?.name ?? '科技'} · 剩余 ${Math.ceil(remaining / 10)} 秒`;
    } else {
      panelRefs.researchInfo.textContent = '';
    }

    const built = [...(cityState.buildings ?? [])];
    const slots = balance.buildingSlots ?? 2;
    panelRefs.buildingInfo.textContent =
      `建筑槽 ${built.length}/${slots}` +
      (built.length > 0
        ? ` · ${built.map((/** @type {string} */ id) => buildingById(balance, id)?.name ?? id).join(' · ')}`
        : '');
    const buildingEffectsTotal = buildingEffects(balance, {
      buildings: built,
    });
    for (const [buildingId, entry] of panelRefs.buildings ?? []) {
      const has = built.includes(buildingId);
      entry.button.textContent = has
        ? `${entry.building.name} · 已建造`
        : `${entry.building.name}（${entry.building.description}）· ${entry.building.costGold} 金`;
      entry.button.disabled =
        has || built.length >= slots || player.gold < entry.building.costGold;
    }
    panelRefs.garrisonCapMultiplier = 1 + buildingEffectsTotal.garrisonCap;

    // Diplomacy rows.
    const allyCount = countAllies(snapshot, myPlayerId);
    for (const [otherId, ref] of panelRefs.diplomacy ?? []) {
      const relation = getRelation(snapshot, myPlayerId, otherId);
      const label = relationLabel(snapshot, myPlayerId, otherId);
      ref.info.textContent = `${ref.player.name} · ${label}`;
      const isAlly = relation?.status === 'ally';
      const truceActive =
        relation?.status === 'truce' && snapshot.tick < (relation.untilTick ?? 0);
      ref.breakButton.style.display = isAlly ? '' : 'none';
      ref.allyButton.style.display = isAlly ? 'none' : '';
      ref.truceButton.style.display = isAlly || truceActive ? 'none' : '';
      ref.allyButton.disabled =
        allyCount >= (balance.diplomacy?.maxAllies ?? 2) ||
        isBlocked(snapshot, myPlayerId, otherId) ||
        Boolean(relation);
      ref.truceButton.disabled = Boolean(relation);
    }

    const incoming = (snapshot.diplomacyRequests ?? []).filter(
      (/** @type {any} */ request) => request.to === myPlayerId,
    );
    const signature = incoming
      .map((/** @type {any} */ request) => `${request.id}:${request.kind}`)
      .join(',');
    if (signature !== panelRefs.requestsSignature) {
      panelRefs.requestsSignature = signature;
      panelRefs.requestsList.replaceChildren();
      for (const request of incoming) {
        const row = createElement('div', 'diplomacy-request');
        const from = snapshot.players[request.from];
        row.append(
          createElement(
            'span',
            'diplomacy-info',
            `${from?.name ?? '玩家'} 请求${request.kind === 'ally' ? '结盟' : '停战'}`,
          ),
        );
        const actions = createElement('div', 'diplomacy-actions');
        const accept = createElement('button', '', '接受');
        accept.addEventListener('click', () => {
          send({
            type: 'command',
            command: { type: 'diplomacy', action: 'accept', requestId: request.id },
          });
        });
        const decline = createElement('button', '', '拒绝');
        decline.addEventListener('click', () => {
          send({
            type: 'command',
            command: { type: 'diplomacy', action: 'decline', requestId: request.id },
          });
        });
        actions.append(accept, decline);
        row.append(actions);
        panelRefs.requestsList.append(row);
      }
    }
  }

  if (panelRefs.amountSlider) {
    const garrison = cityState.garrison;
    panelRefs.amountSlider.max = String(Math.max(1, garrison));
    const ratio = panelRefs.amountRatio ?? 0.75;
    let value = Math.round(garrison * ratio);
    value = Math.min(Math.max(0, value), garrison);
    if (garrison > 0 && value < 1) value = 1;
    panelRefs.amountSlider.value = String(Math.max(1, value));
    panelRefs.amountCount.textContent =
      garrison <= 0
        ? '0'
        : `${value}（${Math.round(ratio * 100)}%）`;
  }
}

function showResult() {
  if (!snapshot.result) return;
  const result = snapshot.result;
  const ranking = result.ranking ?? [];

  if (!isMultiplayer && result.outcome === 'objectives') {
    resultTitle.textContent = '战略目标胜利';
    resultDetail.textContent =
      `控制关键据点 · 分数 ${result.score} · 城市 ${result.cities}` +
      (result.ranking?.findIndex(
        (/** @type {any} */ entry) => entry.id === 0,
      ) >= 0
        ? ` · 第 ${result.ranking.findIndex((/** @type {any} */ entry) => entry.id === 0) + 1} 名`
        : '');
    resultRanking.replaceChildren();
    for (const [index, entry] of ranking.entries()) {
      const row = createElement('div', entry.id === 0 ? 'result-row me' : 'result-row');
      const dot = createElement('i', 'standing-dot');
      dot.style.background = entry.color;
      row.append(
        dot,
        createElement('span', '', `${index + 1}. ${entry.name} · ${entry.cityCount} 城 · ${entry.score} 分`),
      );
      resultRanking.append(row);
    }
    resultElement.classList.remove('hidden');
    return;
  }

  if (!isMultiplayer && snapshot.mode === 'endless') {
    const wave = snapshot.result.wave ?? 0;
    const best = Math.max(
      Number(window.localStorage.getItem('wop-endless-best') ?? 0),
      wave,
    );
    window.localStorage.setItem('wop-endless-best', String(best));
    resultTitle.textContent =
      snapshot.result.outcome === 'won' ? '无尽胜利' : '无尽结束';
    resultDetail.textContent =
      `生存 ${wave} 波 · 分数 ${snapshot.result.score} · 历史最佳 ${best} 波`;
  } else if (isMultiplayer) {
    const myEntry = ranking.find((entry) => entry.id === myPlayerId);
    const myRank = myEntry ? ranking.indexOf(myEntry) + 1 : null;
    if (result.outcome === 'victory') {
      resultTitle.textContent =
        result.winner === myPlayerId ? '胜利' : result.winner === null ? '对局结束' : '结束';
    } else {
      resultTitle.textContent = '时间到';
    }
    const waveInfo =
      result.wave !== undefined && result.wave !== null
        ? ` · 第 ${result.wave} 波`
        : '';
    resultDetail.textContent = myEntry
      ? `城市 ${myEntry.cityCount} · 分数 ${myEntry.score} · 歼敌 ${Math.round(myEntry.kills)}` +
        (myRank ? ` · 第 ${myRank} 名` : '') +
        waveInfo
      : '观战中';
  } else {
    const outcome = result.outcome;
    resultTitle.textContent =
      outcome === 'won' ? '胜利' : outcome === 'lost' ? '战败' : '时间到';
    resultDetail.textContent =
      `分数 ${result.score} · 城市 ${result.cities} · ` +
      `歼敌 ${Math.round(result.kills)}` +
      (result.rank ? ` · 第 ${result.rank} 名` : '');
  }

  resultRanking.replaceChildren();
  ranking.forEach((entry, index) => {
    const row = createElement(
      'div',
      entry.id === (isMultiplayer ? myPlayerId : 0) ? 'result-row me' : 'result-row',
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
  const now = performance.now();
  effects = effects.filter((effect) => now - effect.started < 900);
  const activeEffects = effects.map((effect) => ({
    cityId: effect.cityId,
    type: effect.type,
    progress: (now - effect.started) / 900,
  }));
  drawMatch(context, map, snapshot, camera, {
    viewWidth: window.innerWidth,
    viewHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    hoverId,
    selectedId,
    selectedIds: [...multiSelected],
    tick: snapshot.tick,
    dispatchFrom,
    dispatchPoint,
    dispatchTarget,
    dispatchAmount,
    dispatchOdds,
    effects: activeEffects,
  });
  if (effects.length > 0) requestDraw();
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
    snapshot.cities[selectedId]?.owner === myPlayerId
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
    dispatchAmount = sliderValue || (current ? Math.max(1, Math.ceil(current.garrison * 0.75)) : 0);
    dispatchOdds = null;
    if (dispatchTarget >= 0 && dispatchAmount > 0) {
      const targetState = snapshot.cities[dispatchTarget];
      if (targetState.owner !== myPlayerId) {
        const sent = splitUnits(
          current?.units ?? { infantry: current?.garrison ?? 0 },
          dispatchAmount,
        ).taken;
        const attackerTech = playerTech(myPlayerId);
        const defenderTech =
          targetState.owner === null ? {} : playerTech(targetState.owner);
        const defenderBuildings = buildingEffects(balance, {
          buildings: targetState.buildings ?? [],
        });
        dispatchOdds = Math.round(
          estimateBattle(
            sent,
            {
              level: targetState.level,
              garrison: targetState.garrison,
              units: targetState.units,
              terrain: map.cities[dispatchTarget].terrain,
            },
            balance,
            {
              attackerAttack: attackerTech.attack,
              defenderDefense:
              (defenderTech.defense ?? 0) + (defenderBuildings.defense ?? 0),
              siegeBonus: attackerTech.siege,
            },
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
  if (!current || current.owner !== myPlayerId) return;
  if (current.garrison <= 0) {
    showToast('该城没有可派出的部队');
    return;
  }
  const source = map.cities[selectedId];
  const isOwn = snapshot.cities[targetId].owner === myPlayerId;
  if (!isOwn) {
    const landRoute = source.neighbors.includes(targetId);
    const seaRoute = (source.seaNeighbors ?? []).includes(targetId);
    if (!landRoute && !seaRoute) {
      showToast('只能攻击相邻或可渡海的城市');
      return;
    }
  }
  const sliderValue = Number(panelRefs?.amountSlider?.value);
  const soldiers = Math.max(
    1,
    Math.max(
      1,
      Math.min(
        sliderValue || Math.ceil(current.garrison * 0.75),
        current.garrison,
      ),
    ),
  );
  send({
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
    multiSelected.clear();
    multiPanelSignature = '';
    hidePanel();
    requestDraw();
    return;
  }

  if (event.shiftKey) {
    if (snapshot.cities[id].owner !== myPlayerId) {
      showToast('Shift 多选只能选择自己的城市');
      return;
    }
    // Seed the set with the currently selected city so Shift+click adds to it.
    if (
      multiSelected.size === 0 &&
      selectedId >= 0 &&
      selectedId !== id &&
      snapshot.cities[selectedId]?.owner === myPlayerId
    ) {
      multiSelected.add(selectedId);
    }
    if (multiSelected.has(id)) multiSelected.delete(id);
    else multiSelected.add(id);
    if (multiSelected.size === 0) {
      multiSelected.clear();
    }
    selectedId = id;
    renderPanel();
    requestDraw();
    return;
  }

  multiSelected.clear();
  multiPanelSignature = '';
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

function setPaused(next) {
  if (isMultiplayer) return;
  if (!snapshot || snapshot.phase !== 'playing') return;
  paused = Boolean(next);
  pauseButton.textContent = paused ? '继续' : '暂停';
  send({ type: paused ? 'pause' : 'resume' });
  pauseMenu.classList.toggle('hidden', !paused);
  if (paused) {
    pauseDetail.textContent =
      `${difficulty?.label ?? '普通'}难度 · ` +
      `${gameMode === 'endless' ? '无尽模式' : `${Math.round(matchSeconds / 60)} 分钟`} · ` +
      `种子 ${seed}`;
  }
}

function goSetup() {
  window.location.href = `/setup.html?${startQuery.toString()}`;
}

const COACH_STEPS = [
  {
    title: '选中你的城市',
    description: '地图上红色区域是你的领土。点击任意你的城市，左侧会打开城市面板。',
    check: () =>
      selectedId >= 0 &&
      Boolean(snapshot) &&
      snapshot.cities[selectedId]?.owner === myPlayerId,
  },
  {
    title: '招募部队',
    description: '点面板里的「招募步兵 ×10」，补充驻军。',
    check: () => {
      if (!snapshot) return false;
      let total = 0;
      for (const city of snapshot.cities) {
        if (city.owner !== myPlayerId) continue;
        total += city.units?.infantry ?? city.garrison ?? 0;
      }
      if (coachStartUnits === null) coachStartUnits = total;
      return total > coachStartUnits;
    },
  },
  {
    title: '占领一座城市',
    description: '在「快捷进攻」里点相邻城市的「进攻」，或拖兵过去占领它。',
    check: () => {
      const player = snapshot?.players?.[myPlayerId];
      if (!player) return false;
      if (coachStartCities === null) coachStartCities = player.cityCount;
      return player.cityCount > coachStartCities;
    },
  },
];

function updateCoach() {
  if (!coachMode || coachDismissed || !snapshot) return;
  const player = snapshot.players?.[myPlayerId];
  if (!player) return;
  while (
    coachStep < COACH_STEPS.length &&
    COACH_STEPS[coachStep].check()
  ) {
    coachStep += 1;
  }
  if (coachStep >= COACH_STEPS.length) {
    coachElement.classList.add('hidden');
    if (!coachDismissed) {
      coachDismissed = true;
      showToast('新手引导完成，按 Tab 查看国家总览');
    }
    return;
  }
  const step = COACH_STEPS[coachStep];
  coachElement.classList.remove('hidden');
  coachTitle.textContent = `${coachStep + 1}/${COACH_STEPS.length} · ${step.title}`;
  coachDesc.textContent = step.description;
}

if (coachMode) {
  mustElement('coach-dismiss').addEventListener('click', () => {
    coachDismissed = true;
    coachElement.classList.add('hidden');
  });
}

if (tutorialMode) {
  tutorialPanel.classList.remove('hidden');
  mustElement('tutorial-skip').addEventListener('click', () => {
    window.location.href = '/setup.html';
  });
  mustElement('tutorial-exit').addEventListener('click', () => {
    window.location.href = '/';
  });
  mustElement('tutorial-start').addEventListener('click', () => {
    window.location.href = '/setup.html';
  });
  mustElement('tutorial-home').addEventListener('click', () => {
    window.location.href = '/';
  });
}

overviewButton.addEventListener('click', () => toggleOverview());
overviewClose.addEventListener('click', () => toggleOverview(false));
window.addEventListener('keydown', (event) => {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target.closest('input, textarea, select')
  ) {
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    toggleOverview();
  } else if (event.key === 'Escape' && overviewOpen) {
    event.preventDefault();
    toggleOverview(false);
  }
});

pauseButton.addEventListener('click', () => setPaused(!paused));

speedButton.addEventListener('click', () => {
  speed = speed === 1 ? 2 : 1;
  speedButton.textContent = `${speed}×`;
  send({ type: 'speed', speed });
});

mustElement('button-menu').addEventListener('click', () => {
  if (isMultiplayer) {
    leaveMultiplayer('/multiplayer.html');
    return;
  }
  setPaused(true);
});
mustElement('button-resume').addEventListener('click', () => setPaused(false));
mustElement('button-restart-same').addEventListener('click', () => {
  window.location.href = `/game.html?${startQuery.toString()}`;
});
mustElement('button-pause-settings').addEventListener('click', goSetup);
mustElement('button-pause-home').addEventListener('click', () => {
  window.location.href = '/';
});

mustElement('button-home').addEventListener('click', () => {
  if (isMultiplayer) leaveMultiplayer('/multiplayer.html');
  else window.location.href = '/';
});
mustElement('button-result-settings').addEventListener('click', goSetup);

mustElement('button-restart').addEventListener('click', () => {
  if (isMultiplayer) {
    leaveMultiplayer('/multiplayer.html');
    return;
  }
  startQuery.set('seed', String(Math.floor(Math.random() * 1_000_000)));
  window.location.href = `/game.html?${startQuery.toString()}`;
});

window.addEventListener('keydown', (event) => {
  if (isMultiplayer) return;
  if (event.key === 'Escape') setPaused(!paused);
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
    send({ type: 'command', command });
  },
  isMultiplayer: () => isMultiplayer,
  playerId: () => myPlayerId,
  cityScreen: (/** @type {number} */ id) => {
    const city = map?.cities?.[id];
    if (!city) return null;
    const [x, y] = camera.worldToScreen(city.center[0], city.center[1]);
    return { x, y };
  },
};
