// @ts-check
/**
 * Multiplayer lobby: room list, create/join, room view. The actual match opens
 * in /game.html?room=CODE, where the game page reconnects with the saved token.
 */

import {
  CITY_COUNT_OPTIONS,
  MATCH_LENGTH_OPTIONS,
  MAX_PLAYERS_OPTIONS,
} from '../shared/multiplayer.js';

/** @param {string} id */
function mustElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

const nameInput = /** @type {HTMLInputElement} */ (mustElement('lobby-name'));
const createForm = /** @type {HTMLFormElement} */ (mustElement('create-room-form'));
const joinForm = /** @type {HTMLFormElement} */ (mustElement('join-room-form'));
const createCities = /** @type {HTMLSelectElement} */ (mustElement('create-cities'));
const createMinutes = /** @type {HTMLSelectElement} */ (mustElement('create-minutes'));
const createMaxPlayers = /** @type {HTMLSelectElement} */ (mustElement('create-max-players'));
const createMode = /** @type {HTMLSelectElement} */ (mustElement('create-mode'));
const joinCode = /** @type {HTMLInputElement} */ (mustElement('join-code'));
const roomListElement = mustElement('room-list');
const lobbyMain = mustElement('lobby-main');
const lobbyRoom = mustElement('lobby-room');
const roomCodeDisplay = mustElement('room-code-display');
const roomSummary = mustElement('room-summary');
const roomMembers = mustElement('room-members');
const startRoomButton = /** @type {HTMLButtonElement} */ (mustElement('start-room'));
const leaveRoomButton = mustElement('leave-room');
const refreshButton = mustElement('refresh-rooms');
const statusElement = mustElement('lobby-status');
const mainColumn = document.querySelector('.lobby-column');

const PHASE_LABELS = {
  idle: '等待中',
  playing: '对局中',
  ended: '已结束',
};

/** @type {WebSocket | null} */
let ws = null;
let token = window.sessionStorage.getItem('wop-token') ?? '';
/** @type {any} */
let currentRoom = null;
let hasWelcomed = false;
let started = false;
let listTimer = 0;

/** @param {string} message */
function setStatus(message) {
  statusElement.textContent = message;
}

/** @param {any} message */
function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function populateSelects() {
  for (const count of CITY_COUNT_OPTIONS) {
    const option = document.createElement('option');
    option.value = String(count);
    option.textContent = `${count} 座`;
    createCities.append(option);
  }
  createCities.value = '240';

  for (const seconds of MATCH_LENGTH_OPTIONS) {
    const option = document.createElement('option');
    option.value = String(seconds);
    option.textContent = `${seconds / 60} 分钟`;
    createMinutes.append(option);
  }
  createMinutes.value = '600';

  for (const count of MAX_PLAYERS_OPTIONS) {
    const option = document.createElement('option');
    option.value = String(count);
    option.textContent = `${count} 人`;
    createMaxPlayers.append(option);
  }
  createMaxPlayers.value = '32';
}

function renderRoomList(rooms) {
  roomListElement.replaceChildren();
  if (!Array.isArray(rooms) || rooms.length === 0) {
    roomListElement.append(
      createElement('p', 'room-list-empty', '还没有房间，创建一个吧。'),
    );
    return;
  }

  for (const room of rooms) {
    const row = createElement('div', 'room-row');
    row.append(createElement('span', 'room-row-code', room.code));
    row.append(
      createElement(
        'span',
        'room-row-meta',
        `${room.playerCount}/${room.maxPlayers} 人 · ${room.cityCount} 城 · ` +
          `${room.mode === 'endless' ? '无尽模式' : `${room.matchSeconds / 60} 分钟`} · ` +
          `${PHASE_LABELS[room.phase] ?? room.phase}`,
      ),
    );
    row.append(createElement('span', 'room-row-meta', `房主 ${room.host || '—'}`));
    const button = createElement(
      'button',
      '',
      room.phase === 'ended' ? '观战' : '加入',
    );
    button.addEventListener('click', () => {
      send({ type: 'join', code: room.code });
    });
    row.append(button);
    roomListElement.append(row);
  }
}

function renderRoom() {
  if (!currentRoom) {
    lobbyMain.classList.remove('hidden');
    lobbyRoom.classList.add('hidden');
    return;
  }
  lobbyMain.classList.add('hidden');
  lobbyRoom.classList.remove('hidden');

  roomCodeDisplay.textContent = currentRoom.code;
  roomSummary.textContent =
    `${currentRoom.playerCount}/${currentRoom.maxPlayers} 人 · ` +
    `${currentRoom.cityCount} 城 · ` +
    `${currentRoom.mode === 'endless' ? '无尽模式' : `${currentRoom.matchSeconds / 60} 分钟`} · ` +
    `${PHASE_LABELS[currentRoom.phase] ?? currentRoom.phase}`;

  roomMembers.replaceChildren();
  for (const member of currentRoom.members ?? []) {
    const item = document.createElement('li');
    item.append(
      createElement('span', '', `${member.name}${member.host ? '（房主）' : ''}`),
    );
    item.append(
      createElement(
        'span',
        'member-state',
        member.connected ? '在线' : '离线',
      ),
    );
    roomMembers.append(item);
  }

  const isHost = Boolean(currentRoom.you?.host);
  startRoomButton.classList.toggle(
    'hidden',
    !(isHost && currentRoom.phase === 'idle'),
  );
  if (isHost && currentRoom.phase === 'idle') {
    startRoomButton.textContent =
      currentRoom.playerCount <= 1 ? '开始对局（单人测试）' : '开始对局';
  }
}

function requestRooms() {
  send({ type: 'list' });
}

/** @param {any} message */
function handleMessage(message) {
  if (message.type === 'hello') return;

  if (message.type === 'welcome') {
    hasWelcomed = true;
    token = message.token;
    window.sessionStorage.setItem('wop-token', token);
    setStatus('已连接');
    requestRooms();
    window.clearInterval(listTimer);
    listTimer = window.setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) requestRooms();
    }, 2500);
    return;
  }

  if (message.type === 'rooms') {
    renderRoomList(message.rooms);
    return;
  }

  if (message.type === 'room') {
    currentRoom = message.room;
    renderRoom();
    return;
  }

  if (message.type === 'started') {
    started = true;
    window.clearInterval(listTimer);
    const code = message.roomCode ?? currentRoom?.code ?? '';
    window.location.href = `/game.html?room=${encodeURIComponent(code)}`;
    return;
  }

  if (message.type === 'error') {
    setStatus(message.message ?? '操作失败');
    return;
  }

  if (message.type === 'left') {
    currentRoom = null;
    renderRoom();
    requestRooms();
  }
}

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  ws.addEventListener('open', () => {
    send({
      type: 'hello',
      token: window.sessionStorage.getItem('wop-token') ?? '',
      name: window.localStorage.getItem('wop-name') ?? '指挥官',
    });
  });
  ws.addEventListener('message', (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch {
      // ignore malformed frames
    }
  });
  ws.addEventListener('close', () => {
    if (started) return;
    window.clearInterval(listTimer);
    hasWelcomed = false;
    setStatus('连接断开，正在重连…');
    window.setTimeout(connect, 1500);
  });
  ws.addEventListener('error', () => {});
}

populateSelects();
nameInput.value = window.localStorage.getItem('wop-name') ?? '指挥官';
renderRoom();
connect();

nameInput.addEventListener('change', () => {
  const name = nameInput.value.trim().slice(0, 16) || '指挥官';
  nameInput.value = name;
  window.localStorage.setItem('wop-name', name);
  if (hasWelcomed) send({ type: 'rename', name });
});

createForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!hasWelcomed) {
    setStatus('正在连接，请稍候…');
    return;
  }
  send({
    type: 'create',
    config: {
      cityCount: Number(createCities.value),
      matchSeconds: Number(createMinutes.value),
      maxPlayers: Number(createMaxPlayers.value),
      mode: createMode.value,
    },
  });
});

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!hasWelcomed) {
    setStatus('正在连接，请稍候…');
    return;
  }
  const code = joinCode.value.trim().toUpperCase();
  if (!code) {
    setStatus('请输入房间码');
    return;
  }
  send({ type: 'join', code });
});

refreshButton.addEventListener('click', () => requestRooms());

startRoomButton.addEventListener('click', () => {
  send({ type: 'start' });
});

leaveRoomButton.addEventListener('click', () => {
  send({ type: 'leave' });
});

// The room view replaces the lobby; keep the column width stable.
if (mainColumn) mainColumn.classList.add('is-lobby');
