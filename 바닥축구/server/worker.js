import {
  addMatchPlayer,
  canStartMatch,
  createMatch,
  finishMatch,
  removeMatchPlayer,
  serializeMatch,
  setPlayerConnected,
  setPlayerInput,
  startMatchCountdown,
  stepMatch,
} from "../shared/physics.js";

const LOBBY_NAME = "global";
const ROOM_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const RECONNECT_GRACE_MS = 15_000;
const BROADCAST_INTERVAL_MS = 33;
const SIMULATION_INTERVAL_MS = 16;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === "/api/health") {
        return json({ ok: true, service: "neon-futsal-online" }, 200, cors);
      }

      if (url.pathname === "/api/rooms" && request.method === "GET") {
        return lobbyStub(env).fetch(new Request("https://lobby/rooms", { headers: cors }));
      }

      if (url.pathname === "/api/rooms" && request.method === "POST") {
        const body = await readJson(request);
        return lobbyStub(env).fetch(
          new Request("https://lobby/rooms", {
            method: "POST",
            headers: { "content-type": "application/json", ...cors },
            body: JSON.stringify(body),
          }),
        );
      }

      const socketMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/socket$/);
      if (socketMatch && request.method === "GET") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return json({ error: "WebSocket upgrade required" }, 426, cors);
        }
        const roomId = socketMatch[1];
        const room = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(roomId));
        const headers = new Headers(request.headers);
        headers.set("x-room-id", roomId);
        headers.set("x-player-name", sanitizeText(url.searchParams.get("name"), 16, "PLAYER"));
        headers.set("x-reconnect-token", sanitizeToken(url.searchParams.get("token")));
        return room.fetch(new Request("https://room/socket", { headers }));
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      console.error(error);
      return json({ error: "Server error" }, 500, cors);
    }
  },
};

export class Lobby {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const cors = copyCorsHeaders(request.headers);
    const rooms = (await this.ctx.storage.get("rooms")) ?? {};
    const now = Date.now();

    for (const [roomId, room] of Object.entries(rooms)) {
      if (now - room.updatedAt > ROOM_MAX_AGE_MS || room.status === "removed") delete rooms[roomId];
    }

    if (url.pathname === "/rooms" && request.method === "GET") {
      await this.ctx.storage.put("rooms", rooms);
      const list = Object.values(rooms)
        .filter((room) => room.status !== "ended")
        .sort((a, b) => b.createdAt - a.createdAt);
      return json({ rooms: list, serverTime: now }, 200, cors);
    }

    if (url.pathname === "/rooms" && request.method === "POST") {
      const payload = await readJson(request);
      const roomName = sanitizeText(payload.roomName, 24, "새 경기");
      const teamSize = clampInt(payload.teamSize, 1, 4, 1);
      const durationMinutes = clampInt(payload.durationMinutes, 1, 10, 2);
      const roomId = randomRoomId();
      const room = {
        id: roomId,
        name: roomName,
        teamSize,
        durationMinutes,
        capacity: teamSize * 2,
        occupancy: 0,
        status: "waiting",
        createdAt: now,
        updatedAt: now,
      };

      const stub = this.env.GAME_ROOMS.get(this.env.GAME_ROOMS.idFromName(roomId));
      const initialized = await stub.fetch(
        new Request("https://room/init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(room),
        }),
      );
      if (!initialized.ok) return json({ error: "Could not initialize room" }, 500, cors);

      rooms[roomId] = room;
      await this.ctx.storage.put("rooms", rooms);
      return json({ room }, 201, cors);
    }

    if (url.pathname === "/update" && request.method === "PUT") {
      const update = await readJson(request);
      if (!update?.id || !rooms[update.id]) return json({ ok: false }, 404, cors);
      rooms[update.id] = {
        ...rooms[update.id],
        occupancy: clampInt(update.occupancy, 0, rooms[update.id].capacity, 0),
        status: ["waiting", "countdown", "playing", "goldenGoal", "ended"].includes(update.status)
          ? update.status
          : rooms[update.id].status,
        updatedAt: now,
      };
      await this.ctx.storage.put("rooms", rooms);
      return json({ ok: true }, 200, cors);
    }

    if (url.pathname === "/remove" && request.method === "DELETE") {
      const body = await readJson(request);
      if (body?.id) delete rooms[body.id];
      await this.ctx.storage.put("rooms", rooms);
      return json({ ok: true }, 200, cors);
    }

    return json({ error: "Not found" }, 404, cors);
  }
}

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.config = null;
    this.match = null;
    this.clients = new Map();
    this.tokenPlayers = new Map();
    this.disconnectTimers = new Map();
    this.loopTimer = null;
    this.lastLoopAt = Date.now();
    this.lastBroadcastAt = 0;
    this.closed = false;
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.config = (await this.ctx.storage.get("config")) ?? null;
      if (this.config) this.match = createMatch(this.config);
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      if (!this.config) {
        const body = await readJson(request);
        this.config = {
          id: sanitizeText(body.id, 20, randomRoomId()),
          name: sanitizeText(body.name, 24, "새 경기"),
          teamSize: clampInt(body.teamSize, 1, 4, 1),
          durationMinutes: clampInt(body.durationMinutes, 1, 10, 2),
          capacity: clampInt(body.capacity, 2, 8, 2),
        };
        this.match = createMatch(this.config);
        await this.ctx.storage.put("config", this.config);
      }
      return json({ ok: true });
    }

    if (url.pathname === "/socket") return this.acceptSocket(request);
    return json({ error: "Not found" }, 404);
  }

  acceptSocket(request) {
    if (!this.config || !this.match) return json({ error: "Room is not ready" }, 503);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket upgrade required" }, 426);
    }

    const name = sanitizeText(request.headers.get("x-player-name"), 16, "PLAYER");
    const requestedToken = sanitizeToken(request.headers.get("x-reconnect-token"));
    let player = null;
    let token = requestedToken;

    if (token && this.tokenPlayers.has(token)) {
      const playerId = this.tokenPlayers.get(token);
      player = this.match.players.find((entry) => entry.id === playerId && !entry.connected);
    }

    if (!player) {
      if (this.match.status !== "waiting" || this.match.players.length >= this.config.capacity) {
        return json({ error: "방이 가득 찼거나 이미 경기 중입니다." }, 409);
      }
      const playerId = crypto.randomUUID();
      token = crypto.randomUUID();
      player = addMatchPlayer(this.match, { id: playerId, name });
      if (!player) return json({ error: "빈 자리가 없습니다." }, 409);
      this.tokenPlayers.set(token, playerId);
    } else {
      setPlayerConnected(this.match, player.id, true);
      const timer = this.disconnectTimers.get(player.id);
      if (timer) clearTimeout(timer);
      this.disconnectTimers.delete(player.id);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const connection = {
      socket: server,
      playerId: player.id,
      token,
      lastMessageAt: 0,
      messagesThisSecond: 0,
      rateWindowAt: Date.now(),
    };
    this.clients.set(player.id, connection);

    server.addEventListener("message", (event) => this.handleMessage(connection, event.data));
    server.addEventListener("close", () => this.handleDisconnect(connection));
    server.addEventListener("error", () => this.handleDisconnect(connection));

    this.send(connection, {
      type: "welcome",
      playerId: player.id,
      token,
      room: this.config,
      state: serializeMatch(this.match),
      serverTime: Date.now(),
    });
    if (canStartMatch(this.match)) startMatchCountdown(this.match);
    if (this.match.status !== "waiting") this.ensureLoop();
    this.broadcastState(true);
    this.updateLobby();

    return new Response(null, { status: 101, webSocket: client });
  }

  handleMessage(connection, raw) {
    if (typeof raw !== "string" || raw.length > 2048) return;
    const now = Date.now();
    if (now - connection.rateWindowAt >= 1000) {
      connection.rateWindowAt = now;
      connection.messagesThisSecond = 0;
    }
    connection.messagesThisSecond += 1;
    if (connection.messagesThisSecond > 80) return;

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === "input") setPlayerInput(this.match, connection.playerId, message.input);
    if (message.type === "ping") this.send(connection, { type: "pong", sentAt: message.sentAt, serverTime: now });
  }

  handleDisconnect(connection) {
    if (this.clients.get(connection.playerId) !== connection) return;
    this.clients.delete(connection.playerId);
    setPlayerConnected(this.match, connection.playerId, false);

    if (this.match.status === "waiting" || this.match.status === "countdown") {
      removeMatchPlayer(this.match, connection.playerId);
      this.tokenPlayers.delete(connection.token);
      if (this.match.status === "countdown") {
        this.match.status = "waiting";
        this.match.countdownSeconds = 3;
      }
    } else if (this.match.status !== "ended") {
      const timer = setTimeout(() => this.forfeitDisconnectedPlayer(connection.playerId, connection.token), RECONNECT_GRACE_MS);
      this.disconnectTimers.set(connection.playerId, timer);
    }

    this.broadcastState(true);
    this.updateLobby();
    if (this.clients.size === 0) this.scheduleEmptyRoomCleanup();
  }

  forfeitDisconnectedPlayer(playerId, token) {
    const player = this.match.players.find((entry) => entry.id === playerId);
    if (!player || player.connected || this.match.status === "ended") return;
    const winner = player.team === "blue" ? "red" : "blue";
    finishMatch(this.match, winner, "disconnect");
    this.tokenPlayers.delete(token);
    this.disconnectTimers.delete(playerId);
    this.broadcastState(true);
    this.updateLobby();
  }

  ensureLoop() {
    if (this.loopTimer) return;
    this.lastLoopAt = Date.now();
    this.loopTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.min(0.1, (now - this.lastLoopAt) / 1000);
      this.lastLoopAt = now;
      const statusBeforeStep = this.match.status;
      stepMatch(this.match, elapsed);
      if (now - this.lastBroadcastAt >= BROADCAST_INTERVAL_MS) {
        this.broadcastState();
        this.lastBroadcastAt = now;
      }
      if (this.match.status !== statusBeforeStep) this.updateLobby();
    }, SIMULATION_INTERVAL_MS);
  }

  broadcastState(immediate = false) {
    const payload = JSON.stringify({
      type: "state",
      state: serializeMatch(this.match),
      serverTime: Date.now(),
      immediate,
    });
    for (const connection of this.clients.values()) {
      try {
        connection.socket.send(payload);
      } catch {
        this.handleDisconnect(connection);
      }
    }
  }

  send(connection, payload) {
    try {
      connection.socket.send(JSON.stringify(payload));
    } catch {
      this.handleDisconnect(connection);
    }
  }

  async updateLobby() {
    if (!this.config) return;
    const status =
      this.match.status === "goldenGoal"
        ? "goldenGoal"
        : ["playing", "goal"].includes(this.match.status)
          ? "playing"
          : this.match.status;
    try {
      await lobbyStub(this.env).fetch(
        new Request("https://lobby/update", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: this.config.id,
            occupancy: this.match.players.filter((player) => player.connected).length,
            status,
          }),
        }),
      );
    } catch (error) {
      console.error("Lobby update failed", error);
    }
  }

  scheduleEmptyRoomCleanup() {
    setTimeout(async () => {
      if (this.clients.size !== 0 || this.closed) return;
      this.closed = true;
      if (this.loopTimer) clearInterval(this.loopTimer);
      this.loopTimer = null;
      try {
        await lobbyStub(this.env).fetch(
          new Request("https://lobby/remove", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: this.config.id }),
          }),
        );
      } finally {
        await this.ctx.storage.deleteAll();
      }
    }, 30_000);
  }
}

function lobbyStub(env) {
  return env.LOBBY.get(env.LOBBY.idFromName(LOBBY_NAME));
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") ?? "";
  const allowed =
    origin === "https://jeonghyeon1.github.io" ||
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:");
  return {
    "access-control-allow-origin": allowed ? origin : "https://jeonghyeon1.github.io",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

function copyCorsHeaders(headers) {
  const copied = {};
  for (const name of [
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "vary",
  ]) {
    const value = headers.get(name);
    if (value) copied[name] = value;
  }
  return copied;
}

function sanitizeText(value, maximum, fallback) {
  const safe = String(value ?? "").replace(/[<>&"'`\\]/g, "").trim().slice(0, maximum);
  return safe || fallback;
}

function sanitizeToken(value) {
  const token = String(value ?? "");
  return /^[a-f0-9-]{20,64}$/i.test(token) ? token : "";
}

function clampInt(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function randomRoomId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 10);
}
