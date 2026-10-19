// @ts-check
/**
 * Authoritative multiplayer server: WebSocket rooms, lobby, reconnect and
 * 10Hz snapshot broadcast. Rooms share the single-player simulation module.
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { generateMap } from '../shared/mapgen.js';
import { snapshot } from '../shared/match.js';
import { step } from '../shared/sim.js';
import {
  addLatePlayer,
  createMultiplayerMatch,
  normalizeRoomConfig,
  randomRoomCode,
} from '../shared/multiplayer.js';

const BALANCE = JSON.parse(
  readFileSync(new URL('../../data/balance.json', import.meta.url), 'utf8'),
);

const MAX_MESSAGE_BYTES = 64 * 1024;
const DISCONNECT_GRACE_MS = 90_000;

/**
 * @typedef {Object} Member
 * @property {string} token
 * @property {string} name
 * @property {import('ws').WebSocket | null} ws
 * @property {boolean} connected
 * @property {number | null} playerId
 */

export class MultiplayerServer {
  /** @param {{ balance?: any, log?: (message: string) => void }} [options] */
  constructor(options = {}) {
    this.balance = options.balance ?? BALANCE;
    this.log = options.log ?? (() => {});
    /** @type {Map<string, any>} */
    this.rooms = new Map();
    /** @type {Map<string, { code: string | null }>} */
    this.tokens = new Map();
    /** @type {Map<import('ws').WebSocket, any>} */
    this.sessions = new Map();
    /** @type {WebSocketServer | null} */
    this.wss = null;
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref?.();
  }

  /** @param {import('node:http').Server} server @param {string} [path] */
  attach(server, path = '/ws') {
    this.wss = new WebSocketServer({ server, path, maxPayload: MAX_MESSAGE_BYTES });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    this.log(`multiplayer WebSocket attached at ${path}`);
    return this;
  }

  close() {
    clearInterval(this.cleanupTimer);
    for (const room of this.rooms.values()) this.clearTimer(room);
    this.rooms.clear();
    this.wss?.close();
    this.wss = null;
  }

  /** @param {import('ws').WebSocket | null} ws @param {any} message */
  send(ws, message) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
  }

  /** @param {import('ws').WebSocket} ws @param {string} message */
  sendError(ws, message) {
    this.send(ws, { type: 'error', message });
  }

  /** @param {import('ws').WebSocket} ws */
  handleConnection(ws) {
    this.sessions.set(ws, {
      token: '',
      name: '指挥官',
      room: null,
      member: null,
      spectator: false,
    });
    ws.on('message', (raw) => this.handleMessage(ws, raw));
    ws.on('close', () => this.handleDisconnect(ws));
    ws.on('error', () => {});
    this.send(ws, { type: 'hello', protocol: 1 });
  }

  /** @param {import('ws').WebSocket} ws @param {Buffer|string} raw */
  handleMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(String(raw).slice(0, MAX_MESSAGE_BYTES));
    } catch {
      this.sendError(ws, '消息格式错误');
      return;
    }
    if (!message || typeof message.type !== 'string') {
      this.sendError(ws, '消息格式错误');
      return;
    }
    const session = this.sessions.get(ws);
    if (!session) return;

    switch (message.type) {
      case 'hello':
        this.handleHello(ws, session, message);
        break;
      case 'list':
        this.send(ws, { type: 'rooms', rooms: this.roomList() });
        break;
      case 'create':
        this.handleCreate(ws, session, message);
        break;
      case 'join':
        this.handleJoin(ws, session, message);
        break;
      case 'leave':
        this.handleLeave(ws, session);
        break;
      case 'start':
        this.handleStart(ws, session);
        break;
      case 'restart':
        this.handleRestart(ws, session);
        break;
      case 'command':
        this.handleCommand(ws, session, message);
        break;
      case 'rename':
        this.handleRename(ws, session, message);
        break;
      case 'ping':
        this.send(ws, { type: 'pong' });
        break;
      default:
        this.sendError(ws, '未知消息');
    }
  }

  /** @param {import('ws').WebSocket} ws @param {any} session @param {any} message */
  handleHello(ws, session, message) {
    session.name = String(message.name ?? '').slice(0, 16) || '指挥官';
    const requestedToken = String(message.token ?? '');
    const known = requestedToken ? this.tokens.get(requestedToken) : null;

    if (requestedToken && known) {
      session.token = requestedToken;
      const room = known.code ? this.rooms.get(known.code) : null;
      const member = room?.members.get(requestedToken);
      if (room && member) {
        member.ws = ws;
        member.connected = true;
        session.room = room;
        session.member = member;
        session.spectator = member.playerId === null;
        session.playerId = member.playerId;
        this.send(ws, { type: 'welcome', token: requestedToken, protocol: 1 });
        this.broadcastRoom(room);
        if (room.phase === 'playing' && member.playerId !== null) {
          this.send(ws, {
            type: 'started',
            roomCode: room.code,
            map: room.map,
            snapshot: snapshot(room.state),
            playerId: member.playerId,
          });
          if (room.paused) this.resumeRoom(room);
        } else {
          this.sendRoomState(ws, room, member);
        }
        return;
      }
      this.tokens.delete(requestedToken);
    }

    // Unknown tokens are replaced, never reused: otherwise two tabs sharing a
    // stale token would fight over the same member slot.
    const token = randomBytes(18).toString('hex');
    session.token = token;
    this.tokens.set(token, { code: null });
    this.send(ws, { type: 'welcome', token, protocol: 1 });
  }

  /** @param {import('ws').WebSocket} ws @param {any} session @param {any} message */
  handleRename(ws, session, message) {
    const name = String(message.name ?? '').slice(0, 16) || '指挥官';
    session.name = name;
    if (session.member) {
      session.member.name = name;
      if (session.room) this.broadcastRoom(session.room);
    }
  }

  /** @param {import('ws').WebSocket} ws @param {any} session @param {any} message */
  handleCreate(ws, session, message) {
    if (session.room) this.handleLeave(ws, session);
    const config = normalizeRoomConfig(message.config ?? message);
    const code = this.uniqueRoomCode();
    const room = {
      code,
      config,
      hostToken: '',
      members: new Map(),
      spectators: new Set(),
      state: null,
      map: null,
      phase: 'idle',
      paused: false,
      commands: [],
      timer: null,
      createdAt: Date.now(),
      lastActive: Date.now(),
    };
    this.rooms.set(code, room);
    const member = this.addMember(ws, session, room);
    room.hostToken = member.token;
    this.log(`room ${code} created by ${member.name}`);
    this.sendRoomState(ws, room, member);
    this.broadcastRoom(room);
  }

  /** @param {import('ws').WebSocket} ws @param {any} session @param {any} message */
  handleJoin(ws, session, message) {
    const code = String(message.code ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) {
      this.sendError(ws, '房间不存在');
      return;
    }
    if (session.room === room && session.member) {
      this.sendRoomState(ws, room, session.member);
      return;
    }
    if (session.room) this.handleLeave(ws, session);

    if (room.phase === 'idle') {
      if (room.members.size >= room.config.maxPlayers) {
        this.sendError(ws, '房间已满');
        return;
      }
      const member = this.addMember(ws, session, room);
      this.sendRoomState(ws, room, member);
      this.broadcastRoom(room);
      return;
    }

    if (room.phase === 'playing') {
      const existing = room.members.get(session.token);
      if (existing) {
        existing.ws = ws;
        existing.connected = true;
        session.member = existing;
        session.room = room;
        session.playerId = existing.playerId;
        this.send(ws, {
          type: 'started',
          roomCode: room.code,
          map: room.map,
          snapshot: snapshot(room.state),
          playerId: existing.playerId,
        });
        if (room.paused) this.resumeRoom(room);
        this.broadcastRoom(room);
        return;
      }

      if (room.members.size >= room.config.maxPlayers) {
        this.addSpectator(ws, session, room);
        return;
      }

      const member = this.addMember(ws, session, room);
      const joined = addLatePlayer(room.state, this.balance, room.map, {
        name: member.name,
        token: member.token,
      });
      if (!joined) {
        room.members.delete(member.token);
        session.member = null;
        this.tokens.delete(member.token);
        this.addSpectator(ws, session, room);
        return;
      }
      member.playerId = joined.playerId;
      session.playerId = joined.playerId;
      this.send(ws, {
        type: 'started',
        roomCode: room.code,
        map: room.map,
        snapshot: snapshot(room.state),
        playerId: joined.playerId,
      });
      this.broadcastRoom(room);
      return;
    }

    // Ended rooms can still be spectated.
    this.addSpectator(ws, session, room);
  }

  /** @param {import('ws').WebSocket} ws @param {any} session @param {any} room */
  addSpectator(ws, session, room) {
    room.spectators.add(ws);
    session.room = room;
    session.member = null;
    session.spectator = true;
    this.send(ws, {
      type: 'started',
      roomCode: room.code,
      map: room.map,
      snapshot: room.state ? snapshot(room.state) : null,
      playerId: null,
    });
    this.broadcastRoom(room);
  }

  /** @param {import('ws').WebSocket} ws @param {any} session */
  handleLeave(ws, session) {
    const room = session.room;
    if (!room) {
      this.send(ws, { type: 'left' });
      return;
    }
    if (session.member) {
      room.members.delete(session.token);
      this.tokens.delete(session.token);
      if (room.hostToken === session.token) {
        room.hostToken = room.members.keys().next().value ?? '';
      }
      session.member = null;
      session.playerId = null;
    }
    room.spectators.delete(ws);
    session.room = null;
    this.send(ws, { type: 'left' });
    this.broadcastRoom(room);
    this.maybeDeleteRoom(room);
  }

  /** @param {import('ws').WebSocket} ws @param {any} session */
  handleStart(ws, session) {
    const room = session.room;
    if (!room || session.token !== room.hostToken) {
      this.sendError(ws, '只有房主可以开始');
      return;
    }
    if (room.phase === 'playing') {
      this.sendError(ws, '对局已经开始');
      return;
    }
    if (room.members.size < 1) {
      this.sendError(ws, '至少需要一名玩家');
      return;
    }

    const members = [...room.members.values()];
    const infos = members.map((member, index) => ({
      id: index,
      name: member.name,
      token: member.token,
    }));
    const map = generateMap({
      seed: Math.floor(Math.random() * 1_000_000_000),
      cityCount: room.config.cityCount,
    });
    const state = createMultiplayerMatch(map, this.balance, infos, {
      matchSeconds: room.config.matchSeconds,
    });

    room.map = map;
    room.state = state;
    room.phase = 'playing';
    room.commands = [];
    room.paused = false;
    members.forEach((member, index) => {
      member.playerId = index;
      const activeSession = this.sessions.get(member.ws);
      if (activeSession) activeSession.playerId = index;
    });

    this.broadcastRoom(room);
    for (const member of room.members.values()) {
      this.send(member.ws, {
        type: 'started',
        roomCode: room.code,
        map,
        snapshot: snapshot(state),
        playerId: member.playerId,
      });
    }
    for (const spectator of room.spectators) {
      this.send(spectator, {
        type: 'started',
        roomCode: room.code,
        map,
        snapshot: snapshot(state),
        playerId: null,
      });
    }
    this.log(`room ${room.code} started with ${members.length} players`);
    this.startRoom(room);
  }

  /** @param {import('ws').WebSocket} ws @param {any} session */
  handleRestart(ws, session) {
    const room = session.room;
    if (!room || session.token !== room.hostToken) {
      this.sendError(ws, '只有房主可以重开');
      return;
    }
    if (room.phase === 'playing') {
      this.sendError(ws, '对局进行中');
      return;
    }
    this.handleStart(ws, session);
  }

  /** @param {import('ws').WebSocket} ws @param {any} session @param {any} message */
  handleCommand(ws, session, message) {
    const room = session.room;
    const command = message.command;
    if (!room || room.phase !== 'playing' || !session.member) return;
    if (session.member.playerId === null) return;
    if (!command || typeof command.type !== 'string') return;
    if (room.commands.length > 300) return;
    room.commands.push({ ...command, owner: session.member.playerId });
  }

  /** @param {import('ws').WebSocket} ws */
  handleDisconnect(ws) {
    const session = this.sessions.get(ws);
    if (!session) return;
    this.sessions.delete(ws);
    const room = session.room;
    if (!room) return;
    if (session.member) {
      session.member.ws = null;
      session.member.connected = false;
      this.broadcastRoom(room);
      const anyConnected = [...room.members.values()].some((member) => member.connected);
      if (!anyConnected && room.phase === 'playing') this.pauseRoom(room);
    } else {
      room.spectators.delete(ws);
    }
  }

  /** @param {import('ws').WebSocket} ws @param {any} session @param {any} room */
  addMember(ws, session, room) {
    /** @type {Member} */
    const member = {
      token: session.token,
      name: session.name,
      ws,
      connected: true,
      playerId: null,
    };
    room.members.set(member.token, member);
    this.tokens.set(member.token, { code: room.code });
    session.room = room;
    session.member = member;
    session.spectator = false;
    session.playerId = null;
    return member;
  }

  /** @param {any} room */
  startRoom(room) {
    this.clearTimer(room);
    room.paused = false;
    room.timer = setInterval(() => this.tickRoom(room), this.balance.tickMs);
    room.timer.unref?.();
  }

  /** @param {any} room */
  pauseRoom(room) {
    this.clearTimer(room);
    room.paused = true;
    this.log(`room ${room.code} paused (no connected players)`);
  }

  /** @param {any} room */
  resumeRoom(room) {
    if (room.phase === 'playing' && !room.timer) this.startRoom(room);
  }

  /** @param {any} room */
  clearTimer(room) {
    if (room.timer) {
      clearInterval(room.timer);
      room.timer = null;
    }
  }

  /** @param {any} room */
  tickRoom(room) {
    if (!room.state || room.phase !== 'playing') return;
    const commands = room.commands;
    room.commands = [];
    step(room.state, this.balance, commands);
    const snap = snapshot(room.state);
    this.broadcast(room, { type: 'snapshot', snapshot: snap });
    if (room.state.phase !== 'playing') {
      room.phase = 'ended';
      this.clearTimer(room);
      this.broadcast(room, { type: 'ended', result: snap.result });
      this.broadcastRoom(room);
      this.log(`room ${room.code} ended`);
    }
  }

  /** @param {any} room @param {any} message */
  broadcast(room, message) {
    for (const member of room.members.values()) this.send(member.ws, message);
    for (const spectator of room.spectators) this.send(spectator, message);
  }

  /** @param {any} room @param {Member} member */
  sendRoomState(ws, room, member) {
    this.send(ws, {
      type: 'room',
      room: {
        ...this.roomSummary(room),
        members: [...room.members.values()].map((entry) => ({
          name: entry.name,
          connected: entry.connected,
          host: entry.token === room.hostToken,
          playerId: entry.playerId,
        })),
        you: member
          ? {
              playerId: member.playerId,
              host: member.token === room.hostToken,
            }
          : { playerId: null, host: false },
      },
    });
  }

  /** @param {any} room */
  broadcastRoom(room) {
    for (const member of room.members.values()) {
      this.sendRoomState(member.ws, room, member);
    }
  }

  /** @param {any} room */
  roomSummary(room) {
    return {
      code: room.code,
      phase: room.phase,
      host: [...room.members.values()].find((member) => member.token === room.hostToken)?.name ?? '',
      playerCount: room.members.size,
      maxPlayers: room.config.maxPlayers,
      cityCount: room.config.cityCount,
      matchSeconds: room.config.matchSeconds,
    };
  }

  roomList() {
    return [...this.rooms.values()]
      .filter((room) => room.phase !== 'ended' || room.members.size > 0)
      .map((room) => this.roomSummary(room));
  }

  uniqueRoomCode() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = randomRoomCode();
      if (!this.rooms.has(code)) return code;
    }
    return randomRoomCode() + String(Date.now() % 1000);
  }

  /** @param {any} room */
  maybeDeleteRoom(room) {
    if (room.members.size > 0) return;
    this.clearTimer(room);
    this.rooms.delete(room.code);
    this.log(`room ${room.code} removed`);
  }

  cleanup() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      const connected = [...room.members.values()].some((member) => member.connected);
      const idle = !connected && now - room.lastActive > 10 * 60_000;
      if (idle) {
        this.clearTimer(room);
        for (const member of room.members.values()) this.tokens.delete(member.token);
        this.rooms.delete(room.code);
      }
    }
  }
}
