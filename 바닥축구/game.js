import { WORLD } from "./shared/physics.js";

const $ = (selector) => document.querySelector(selector);
const canvas = $("#gameCanvas");
const ctx = canvas.getContext("2d");
const lobbyView = $("#lobbyView");
const gameView = $("#gameView");
const roomList = $("#roomList");
const createRoomForm = $("#createRoomForm");
const createRoomButton = $("#createRoomButton");
const nicknameInput = $("#nicknameInput");
const playerNumberInput = $("#playerNumberInput");
const roomNameInput = $("#roomNameInput");
const durationSelect = $("#durationSelect");
const refreshButton = $("#refreshButton");
const leaveButton = $("#leaveButton");
const soundButton = $("#soundButton");
const waitingOverlay = $("#waitingOverlay");
const waitingTitle = $("#waitingTitle");
const waitingDescription = $("#waitingDescription");
const roomModeLabel = $("#roomModeLabel");
const roster = $("#roster");
const blueScoreElement = $("#blueScore");
const redScoreElement = $("#redScore");
const timerElement = $("#timer");
const messageElement = $("#message");
const toastElement = $("#toast");
const connectionDot = $("#connectionDot");
const networkBadge = $("#networkBadge");

const API_BASE = String(window.FUTSAL_CONFIG?.apiBase || "http://localhost:8787").replace(/\/$/, "");
const keys = new Set();
const particles = [];
const ballTrail = [];
let socket = null;
let playerId = null;
let activeRoom = null;
let latestSnapshot = null;
let renderedState = null;
let previousScores = { blue: 0, red: 0 };
let previousStatus = "waiting";
let inputSequence = 0;
let manualClose = false;
let reconnectStartedAt = 0;
let soundEnabled = false;
let audioContext = null;
let toastTimer = 0;
let messageTimer = 0;
let roomPollTimer = 0;
let pingTimer = 0;
let inputTimer = 0;
let lastFrameAt = performance.now();
let lastPingAt = 0;
let roundTripMs = null;

nicknameInput.value = localStorage.getItem("futsal-nickname") || `PLAYER-${Math.floor(1000 + Math.random() * 9000)}`;
playerNumberInput.value = localStorage.getItem("futsal-player-number") || "10";

function saveNickname() {
  const nickname = sanitizeText(nicknameInput.value, 16, "PLAYER");
  nicknameInput.value = nickname;
  localStorage.setItem("futsal-nickname", nickname);
  return nickname;
}

function savePlayerNumber(showError = false) {
  const raw = playerNumberInput.value.trim().toUpperCase();
  const number = sanitizePlayerNumber(raw);
  if (showError && raw !== number) showToast("등번호는 한글 1자 또는 영문·숫자 2자까지 가능합니다.");
  playerNumberInput.value = number;
  localStorage.setItem("futsal-player-number", number);
  return number;
}

async function loadRooms(showLoading = false) {
  if (showLoading) {
    roomList.innerHTML = '<div class="room-empty">방 목록을 새로 불러오는 중입니다.</div>';
    refreshButton.disabled = true;
    refreshButton.classList.add("loading");
    refreshButton.textContent = "불러오는 중…";
  }
  try {
    const response = await fetch(`${API_BASE}/api/rooms`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderRooms(data.rooms || []);
    connectionDot.classList.add("online");
  } catch (error) {
    connectionDot.classList.remove("online");
    roomList.innerHTML =
      '<div class="room-empty">온라인 서버에 연결할 수 없습니다.<br />잠시 뒤 새로고침해주세요.</div>';
    if (showLoading) showToast(`서버 연결 실패: ${error.message}`);
  } finally {
    if (showLoading) {
      refreshButton.disabled = false;
      refreshButton.classList.remove("loading");
      refreshButton.textContent = "↻ 방 목록 새로고침";
    }
  }
}

function renderRooms(rooms) {
  roomList.replaceChildren();
  if (!rooms.length) {
    const empty = document.createElement("div");
    empty.className = "room-empty";
    empty.textContent = "열린 방이 없습니다. 첫 경기를 만들어보세요.";
    roomList.append(empty);
    return;
  }

  rooms.forEach((room) => {
    const row = document.createElement("article");
    row.className = "room-row";

    const name = document.createElement("div");
    name.className = "room-name";
    const title = document.createElement("strong");
    title.textContent = room.name;
    const identifier = document.createElement("small");
    identifier.textContent = `ROOM ${String(room.id).toUpperCase()}`;
    name.append(title, identifier);

    const mode = document.createElement("div");
    mode.className = "room-meta";
    mode.textContent = `${room.teamSize} v ${room.teamSize} · ${room.durationMinutes}분`;

    const status = document.createElement("span");
    status.className = `room-status ${room.status}`;
    status.textContent = roomStatusLabel(room.status);

    const join = document.createElement("button");
    join.className = "join-button";
    join.type = "button";
    join.textContent = `${room.occupancy}/${room.capacity} 참가`;
    join.disabled = room.status !== "waiting" || room.occupancy >= room.capacity;
    join.addEventListener("click", () => joinRoom(room));

    row.append(name, mode, status, join);
    roomList.append(row);
  });
}

async function createRoom(event) {
  event.preventDefault();
  createRoomButton.disabled = true;
  const payload = {
    roomName: sanitizeText(roomNameInput.value, 24, "빠른 경기"),
    durationMinutes: Number(durationSelect.value),
    teamSize: Number(createRoomForm.elements.teamSize.value),
  };

  try {
    const response = await fetch(`${API_BASE}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "방을 만들 수 없습니다.");
    joinRoom(data.room);
  } catch (error) {
    showToast(error.message);
  } finally {
    createRoomButton.disabled = false;
  }
}

function joinRoom(room, reconnect = false) {
  if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
  activeRoom = room;
  manualClose = false;
  const nickname = saveNickname();
  const number = savePlayerNumber();
  const tokenKey = `futsal-token:${room.id}`;
  const token = reconnect ? sessionStorage.getItem(tokenKey) || "" : "";
  const websocketBase = API_BASE.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const url =
    `${websocketBase}/api/rooms/${encodeURIComponent(room.id)}/socket` +
    `?name=${encodeURIComponent(nickname)}&number=${encodeURIComponent(number)}&token=${encodeURIComponent(token)}`;
  socket = new WebSocket(url);

  showGameView();
  waitingOverlay.classList.remove("hidden");
  waitingTitle.textContent = reconnect ? "재접속 중" : "방에 접속하는 중";
  waitingDescription.textContent = room.name;
  roomModeLabel.textContent = `${room.teamSize} v ${room.teamSize} // ${room.durationMinutes} MIN`;

  socket.addEventListener("open", () => {
    reconnectStartedAt = 0;
    connectionDot.classList.add("online");
    startNetworkTimers();
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(message);
  });

  socket.addEventListener("close", (event) => {
    stopNetworkTimers();
    connectionDot.classList.remove("online");
    if (manualClose) return;
    if (event.code === 1000) {
      returnToLobby();
      return;
    }
    attemptReconnect();
  });

  socket.addEventListener("error", () => {
    if (!reconnect) showToast("방 서버 연결에 실패했습니다.");
  });
}

function handleServerMessage(message) {
  if (message.type === "welcome") {
    playerId = message.playerId;
    activeRoom = message.room;
    sessionStorage.setItem(`futsal-token:${activeRoom.id}`, message.token);
    applySnapshot(message.state, message.serverTime, true);
    showToast(`${message.state.players.find((player) => player.id === playerId)?.team.toUpperCase()} 팀 참가 완료`);
    return;
  }
  if (message.type === "state") {
    applySnapshot(message.state, message.serverTime, message.immediate);
    return;
  }
  if (message.type === "pong") {
    roundTripMs = Math.max(0, Date.now() - Number(message.sentAt));
    networkBadge.textContent = `PING ${roundTripMs} ms`;
  }
}

function applySnapshot(state, serverTime, immediate = false) {
  const receivedAt = performance.now();
  latestSnapshot = { state, serverTime, receivedAt };
  if (!renderedState || immediate) renderedState = cloneState(state);

  if (state.scores.blue !== previousScores.blue || state.scores.red !== previousScores.red) {
    const scoringTeam = state.scores.blue > previousScores.blue ? "blue" : "red";
    createBurst(state.ball.x, state.ball.y, scoringTeam === "blue" ? "#24c8ff" : "#ff416d", 38);
    showMessage(`${scoringTeam.toUpperCase()} GOAL!`, 1250);
    playGoalSound();
  }
  if (state.status === "goldenGoal" && previousStatus !== "goldenGoal") {
    showMessage("GOLDEN GOAL", 1800);
    playTone(260, 0.28, "sawtooth", 0.035);
  }
  if (state.status === "ended" && previousStatus !== "ended") {
    const team = state.winner?.toUpperCase() || "";
    showMessage(`${team} WINS!`, 1800);
    playTone(130, 0.35, "sawtooth", 0.025);
  }

  const statusBeforeUpdate = previousStatus;
  previousScores = { ...state.scores };
  previousStatus = state.status;
  updateMatchUi(state, statusBeforeUpdate);
}

function updateMatchUi(state, previousMatchStatus = previousStatus) {
  blueScoreElement.textContent = state.scores.blue;
  redScoreElement.textContent = state.scores.red;
  updateTimer(state);
  renderRoster(state);

  const connected = state.players.filter((player) => player.connected).length;
  const capacity = state.teamSize * 2;
  roomModeLabel.textContent = `${state.teamSize} v ${state.teamSize} // ${state.durationMinutes} MIN`;

  if (state.status === "waiting") {
    waitingOverlay.classList.remove("hidden");
    waitingTitle.textContent = "선수를 기다리는 중";
    waitingDescription.textContent = `${connected}/${capacity}명 접속 · 모두 모이면 자동으로 시작합니다.`;
  } else if (state.status === "countdown") {
    if (state.countdownReason === "restart") {
      waitingOverlay.classList.add("hidden");
      if (previousMatchStatus === "goal") showMessage("KICK OFF!", 550);
    } else {
      waitingOverlay.classList.remove("hidden");
      const count = Math.max(1, Math.ceil(state.countdownSeconds));
      waitingTitle.textContent = count === 1 ? "KICK OFF!" : `${count}`;
      waitingDescription.textContent = "곧 경기가 시작됩니다.";
    }
  } else if (state.status === "ended") {
    waitingOverlay.classList.remove("hidden");
    waitingTitle.textContent = `${state.winner?.toUpperCase() || ""} WINS`;
    waitingDescription.textContent = endReasonText(state.winReason);
  } else {
    waitingOverlay.classList.add("hidden");
  }
}

function updateTimer(state) {
  if (state.goldenGoal && state.status !== "ended") {
    timerElement.textContent = "GOLDEN GOAL";
    timerElement.classList.add("golden");
    return;
  }
  timerElement.classList.remove("golden");
  let seconds = state.remainingSeconds;
  if (state.status === "playing" && latestSnapshot) {
    seconds -= (performance.now() - latestSnapshot.receivedAt) / 1000;
  }
  seconds = Math.max(0, Math.ceil(seconds));
  timerElement.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function renderRoster(state) {
  roster.replaceChildren();
  for (const team of ["blue", "red"]) {
    const box = document.createElement("div");
    box.className = `roster-team ${team}`;
    const heading = document.createElement("span");
    heading.textContent = `${team.toUpperCase()} TEAM`;
    box.append(heading);
    for (let slot = 0; slot < state.teamSize; slot += 1) {
      const player = state.players.find((entry) => entry.team === team && entry.slot === slot);
      const line = document.createElement("div");
      line.className = `roster-player ${player?.id === playerId ? "me" : ""}`;
      const name = document.createElement("span");
      name.textContent = player ? `[${player.number}] ${player.name}` : "빈 자리";
      const status = document.createElement("small");
      status.textContent = player ? (player.connected ? "READY" : "RECONNECT") : "WAIT";
      line.append(name, status);
      box.append(line);
    }
    roster.append(box);
  }
}

function showGameView() {
  lobbyView.classList.add("hidden");
  gameView.classList.remove("hidden");
  leaveButton.classList.remove("hidden");
  clearInterval(roomPollTimer);
}

function leaveRoom() {
  manualClose = true;
  if (socket) socket.close(1000, "Player left");
  socket = null;
  returnToLobby();
}

function returnToLobby() {
  manualClose = true;
  stopNetworkTimers();
  socket = null;
  activeRoom = null;
  playerId = null;
  latestSnapshot = null;
  renderedState = null;
  previousScores = { blue: 0, red: 0 };
  previousStatus = "waiting";
  keys.clear();
  lobbyView.classList.remove("hidden");
  gameView.classList.add("hidden");
  leaveButton.classList.add("hidden");
  loadRooms(true);
  roomPollTimer = setInterval(loadRooms, 2500);
}

function attemptReconnect() {
  if (!activeRoom) returnToLobby();
  if (!reconnectStartedAt) reconnectStartedAt = Date.now();
  if (Date.now() - reconnectStartedAt > 14_000) {
    showToast("재접속 시간이 만료됐습니다.");
    returnToLobby();
    return;
  }
  waitingOverlay.classList.remove("hidden");
  waitingTitle.textContent = "연결 복구 중";
  waitingDescription.textContent = "잠시만 기다려주세요.";
  setTimeout(() => {
    if (!manualClose && activeRoom) joinRoom(activeRoom, true);
  }, 1100);
}

function startNetworkTimers() {
  stopNetworkTimers();
  inputTimer = setInterval(sendInput, 33);
  pingTimer = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    lastPingAt = Date.now();
    socket.send(JSON.stringify({ type: "ping", sentAt: lastPingAt }));
  }, 2000);
}

function stopNetworkTimers() {
  clearInterval(inputTimer);
  clearInterval(pingTimer);
  inputTimer = 0;
  pingTimer = 0;
}

function sendInput() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  inputSequence += 1;
  socket.send(
    JSON.stringify({
      type: "input",
      input: {
        up: keys.has("ArrowUp"),
        down: keys.has("ArrowDown"),
        left: keys.has("ArrowLeft"),
        right: keys.has("ArrowRight"),
        kick:
          keys.has("KeyX") ||
          keys.has("ControlLeft") ||
          keys.has("ControlRight") ||
          keys.has("Space"),
        sequence: inputSequence,
      },
    }),
  );
}

function animate(now) {
  const dt = Math.min((now - lastFrameAt) / 1000, 1 / 30);
  lastFrameAt = now;
  updateParticles(dt);
  smoothRenderedState(dt);
  draw();
  if (latestSnapshot) updateTimer(latestSnapshot.state);
  requestAnimationFrame(animate);
}

function smoothRenderedState(dt) {
  if (!latestSnapshot?.state) return;
  const target = latestSnapshot.state;
  if (!renderedState) {
    renderedState = cloneState(target);
    return;
  }
  renderedState.status = target.status;
  renderedState.goldenGoal = target.goldenGoal;
  renderedState.scores = target.scores;
  const oneWayLatency = Math.min(0.12, Math.max(0, roundTripMs || 0) / 2000);
  const snapshotAge = Math.min(
    0.16,
    oneWayLatency + (performance.now() - latestSnapshot.receivedAt) / 1000,
  );
  renderedState.players = target.players.map((player) => {
    const current = renderedState.players.find((entry) => entry.id === player.id) || player;
    const isLocal = player.id === playerId;
    let renderVx = current.vx;
    let renderVy = current.vy;
    let facingX = player.facingX;
    let facingY = player.facingY;

    if (isLocal) {
      const input = getLocalInputVector();
      if (input.length > 0) {
        renderVx += input.x * 1500 * dt;
        renderVy += input.y * 1500 * dt;
        facingX = input.x;
        facingY = input.y;
      }
      const drag = Math.pow(input.length > 0 ? 0.0008 : 0.00002, dt);
      renderVx *= drag;
      renderVy *= drag;
      const speed = Math.hypot(renderVx, renderVy);
      if (speed > 330) {
        renderVx = (renderVx / speed) * 330;
        renderVy = (renderVy / speed) * 330;
      }
      const velocityCorrection = 1 - Math.exp(-3.5 * dt);
      renderVx = lerp(renderVx, player.vx, velocityCorrection);
      renderVy = lerp(renderVy, player.vy, velocityCorrection);
    } else {
      const velocityBlend = 1 - Math.exp(-18 * dt);
      renderVx = lerp(current.vx, player.vx, velocityBlend);
      renderVy = lerp(current.vy, player.vy, velocityBlend);
    }

    const predictedX = current.x + renderVx * dt;
    const predictedY = current.y + renderVy * dt;
    const serverX = player.x + player.vx * snapshotAge;
    const serverY = player.y + player.vy * snapshotAge;
    const error = Math.hypot(serverX - predictedX, serverY - predictedY);
    const localCorrectionRate = error > 120 ? 18 : error > 55 ? 6 : 1.8;
    const correction = 1 - Math.exp(-(isLocal ? localCorrectionRate : 10) * dt);
    return {
      ...player,
      x: clamp(
        lerp(predictedX, serverX, correction),
        WORLD.field.left - WORLD.playerLineMargin,
        WORLD.field.right + WORLD.playerLineMargin,
      ),
      y: clamp(
        lerp(predictedY, serverY, correction),
        WORLD.field.top - WORLD.playerLineMargin,
        WORLD.field.bottom + WORLD.playerLineMargin,
      ),
      vx: renderVx,
      vy: renderVy,
      facingX,
      facingY,
      kickFlash: isLocal ? Math.max(player.kickFlash, (current.kickFlash || 0) - dt) : player.kickFlash,
    };
  });
  const currentBall = renderedState.ball;
  const predictedBallX = currentBall.x + (currentBall.vx || 0) * dt;
  const predictedBallY = currentBall.y + (currentBall.vy || 0) * dt;
  const serverBallX = target.ball.x + target.ball.vx * snapshotAge;
  const serverBallY = target.ball.y + target.ball.vy * snapshotAge;
  const ballCorrection = 1 - Math.exp(-14 * dt);
  const ballVelocityBlend = 1 - Math.exp(-20 * dt);
  renderedState.ball = {
    ...target.ball,
    x: lerp(predictedBallX, serverBallX, ballCorrection),
    y: lerp(predictedBallY, serverBallY, ballCorrection),
    vx: lerp(currentBall.vx || 0, target.ball.vx, ballVelocityBlend),
    vy: lerp(currentBall.vy || 0, target.ball.vy, ballVelocityBlend),
  };

  const speed = Math.hypot(target.ball.vx, target.ball.vy);
  if (speed > 80) {
    ballTrail.unshift({ x: renderedState.ball.x, y: renderedState.ball.y, life: Math.min(1, speed / 600) });
    if (ballTrail.length > 12) ballTrail.pop();
  } else if (ballTrail.length) {
    ballTrail.pop();
  }
}

function getLocalInputVector() {
  let x = Number(keys.has("ArrowRight")) - Number(keys.has("ArrowLeft"));
  let y = Number(keys.has("ArrowDown")) - Number(keys.has("ArrowUp"));
  const length = Math.hypot(x, y);
  if (length > 0) {
    x /= length;
    y /= length;
  }
  return { x, y, length };
}

function predictLocalKick() {
  if (!renderedState || !playerId) return;
  const player = renderedState.players.find((entry) => entry.id === playerId);
  const ball = renderedState.ball;
  if (!player || !ball) return;
  const dx = ball.x - player.x;
  const dy = ball.y - player.y;
  const distance = Math.hypot(dx, dy);
  if (distance > player.radius + ball.radius + 22) return;
  const nx = distance > 0.001 ? dx / distance : player.facingX;
  const ny = distance > 0.001 ? dy / distance : player.facingY;
  const aimX = nx * 0.58 + player.facingX * 0.42;
  const aimY = ny * 0.58 + player.facingY * 0.42;
  const length = Math.hypot(aimX, aimY) || 1;
  ball.vx = (aimX / length) * 565 + player.vx * 0.18;
  ball.vy = (aimY / length) * 565 + player.vy * 0.18;
  player.kickFlash = 0.16;
  playTone(105, 0.07, "triangle", 0.04);
}

function draw() {
  ctx.clearRect(0, 0, WORLD.width, WORLD.height);
  drawBackground();
  drawGoals();
  drawField();
  if (!renderedState) return;
  drawBallTrail();
  renderedState.players.forEach((player) => drawPlayer(player, player.id === playerId));
  drawBall(renderedState.ball);
  drawParticles();
}

function drawBackground() {
  const gradient = ctx.createLinearGradient(0, 0, WORLD.width, WORLD.height);
  gradient.addColorStop(0, "#07121a");
  gradient.addColorStop(0.5, "#0b1115");
  gradient.addColorStop(1, "#160a10");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WORLD.width, WORLD.height);
  ctx.strokeStyle = "rgba(255,255,255,0.018)";
  for (let x = 0; x <= WORLD.width; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, WORLD.height);
    ctx.stroke();
  }
  for (let y = 0; y <= WORLD.height; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WORLD.width, y);
    ctx.stroke();
  }
}

function drawField() {
  const { field } = WORLD;
  const gradient = ctx.createLinearGradient(field.left, 0, field.right, 0);
  gradient.addColorStop(0, "rgba(20, 61, 68, 0.78)");
  gradient.addColorStop(0.5, "rgba(21, 48, 47, 0.78)");
  gradient.addColorStop(1, "rgba(63, 29, 42, 0.74)");
  ctx.fillStyle = gradient;
  ctx.fillRect(field.left, field.top, field.right - field.left, field.bottom - field.top);

  ctx.strokeStyle = "rgba(217,255,227,0.46)";
  ctx.lineWidth = 3;
  ctx.strokeRect(field.left, field.top, field.right - field.left, field.bottom - field.top);
  ctx.beginPath();
  ctx.moveTo(WORLD.width / 2, field.top);
  ctx.lineTo(WORLD.width / 2, field.bottom);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(WORLD.width / 2, WORLD.height / 2, 84, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(217,255,227,0.58)";
  ctx.beginPath();
  ctx.arc(WORLD.width / 2, WORLD.height / 2, 4, 0, Math.PI * 2);
  ctx.fill();
  drawPenaltyArea(field.left, 1);
  drawPenaltyArea(field.right, -1);
}

function drawPenaltyArea(x, direction) {
  ctx.strokeStyle = "rgba(217,255,227,0.38)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, WORLD.height / 2, 137, -Math.PI / 2, Math.PI / 2, direction < 0);
  ctx.stroke();
  ctx.fillStyle = "rgba(217,255,227,0.48)";
  ctx.beginPath();
  ctx.arc(x + direction * 92, WORLD.height / 2, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawGoals() {
  const activeSide = renderedState?.status === "goal" ? renderedState.lastGoalSide : null;
  drawGoal(WORLD.field.left, -1, "#ff416d", activeSide === "left");
  drawGoal(WORLD.field.right, 1, "#24c8ff", activeSide === "right");
}

function drawGoal(x, direction, color, active) {
  const back = x + WORLD.goal.depth * direction;
  const remaining = latestSnapshot?.state.goalPauseSeconds ?? 0;
  const pulse = active ? clamp(remaining / 1.65, 0, 1) : 0;
  const ripple = active ? Math.sin(performance.now() * 0.035) * (8 + 16 * pulse) : 0;
  const impactY = active && renderedState?.ball ? renderedState.ball.y : WORLD.height / 2;
  ctx.save();
  ctx.strokeStyle = active ? color : "rgba(230,241,242,0.32)";
  ctx.fillStyle = active ? `${color}20` : "rgba(255,255,255,0.025)";
  ctx.lineWidth = active ? 3 : 2;
  ctx.shadowColor = active ? color : "transparent";
  ctx.shadowBlur = active ? 18 * pulse : 0;
  ctx.fillRect(Math.min(x, back), WORLD.goal.top, WORLD.goal.depth, WORLD.goal.bottom - WORLD.goal.top);
  ctx.strokeRect(Math.min(x, back), WORLD.goal.top, WORLD.goal.depth, WORLD.goal.bottom - WORLD.goal.top);
  ctx.strokeStyle = active ? `${color}88` : "rgba(220,230,232,0.1)";
  ctx.lineWidth = active ? 1.8 : 1;
  for (let y = WORLD.goal.top + 18; y < WORLD.goal.bottom; y += 18) {
    const impactFalloff = 1 - Math.min(1, Math.abs(y - impactY) / (WORLD.goal.bottom - WORLD.goal.top));
    ctx.beginPath();
    ctx.moveTo(Math.min(x, back), y);
    ctx.quadraticCurveTo(
      x + direction * WORLD.goal.depth * (0.55 + 0.18 * pulse),
      y + ripple * (0.45 + impactFalloff * 0.75),
      Math.max(x, back),
      y,
    );
    ctx.stroke();
  }
  for (let offset = 12; offset < WORLD.goal.depth; offset += 12) {
    ctx.beginPath();
    ctx.moveTo(x + offset * direction, WORLD.goal.top);
    ctx.quadraticCurveTo(
      x + offset * direction + ripple * direction,
      WORLD.height / 2,
      x + offset * direction,
      WORLD.goal.bottom,
    );
    ctx.stroke();
  }
  ctx.shadowColor = color;
  ctx.shadowBlur = 11;
  ctx.fillStyle = "#e9f4f3";
  for (const y of [WORLD.goal.top, WORLD.goal.bottom]) {
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPlayer(player, isLocal) {
  const color = player.team === "blue" ? "#24c8ff" : "#ff416d";
  const dark = player.team === "blue" ? "#087ea3" : "#a9153a";
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.fillStyle = "rgba(0,0,0,0.38)";
  ctx.beginPath();
  ctx.ellipse(3, 9, player.radius + 7, player.radius - 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = color;
  ctx.shadowBlur = player.kickFlash > 0 ? 28 : 14;
  const gradient = ctx.createRadialGradient(-8, -10, 3, 0, 0, player.radius);
  gradient.addColorStop(0, "#fff");
  gradient.addColorStop(0.14, color);
  gradient.addColorStop(1, dark);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, player.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#071013";
  ctx.font = `${String(player.number || "10").length > 1 ? 700 : 800} 13px Space Mono, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(player.number || "10", 0, 1);
  ctx.rotate(Math.atan2(player.facingY, player.facingX));
  ctx.fillStyle = "#f6ffff";
  ctx.beginPath();
  ctx.arc(player.radius * 0.55, 0, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = isLocal ? "#d9ff43" : "rgba(240,246,247,0.82)";
  ctx.font = "700 10px Space Mono, monospace";
  ctx.textAlign = "center";
  ctx.fillText(player.name, player.x, player.y - player.radius - 13);
}

function drawBall(ball) {
  ctx.save();
  ctx.translate(ball.x, ball.y);
  ctx.shadowColor = "#d9ff43";
  ctx.shadowBlur = 17;
  ctx.fillStyle = "#eefcb7";
  ctx.beginPath();
  ctx.arc(0, 0, ball.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "#25300c";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#4a5e0c";
  ctx.beginPath();
  ctx.arc(-2, -1, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBallTrail() {
  ballTrail.forEach((point, index) => {
    const ratio = 1 - index / ballTrail.length;
    ctx.fillStyle = `rgba(217,255,67,${ratio * 0.12 * point.life})`;
    ctx.beginPath();
    ctx.arc(point.x, point.y, WORLD.ballRadius * ratio, 0, Math.PI * 2);
    ctx.fill();
  });
}

function createBurst(x, y, color, count) {
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 70 + Math.random() * 300;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.45 + Math.random() * 0.55,
      size: 2 + Math.random() * 4,
      color,
    });
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const particle = particles[i];
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vx *= Math.pow(0.12, dt);
    particle.vy *= Math.pow(0.12, dt);
    particle.life -= dt * 1.8;
    if (particle.life <= 0) particles.splice(i, 1);
  }
}

function drawParticles() {
  particles.forEach((particle) => {
    ctx.globalAlpha = Math.max(0, particle.life);
    ctx.fillStyle = particle.color;
    ctx.fillRect(particle.x, particle.y, particle.size, particle.size);
  });
  ctx.globalAlpha = 1;
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  if (soundEnabled && !audioContext) audioContext = new AudioContext();
  soundButton.textContent = soundEnabled ? "SOUND ON" : "SOUND OFF";
  soundButton.classList.toggle("active", soundEnabled);
  playTone(440, 0.06, "square", 0.025);
}

function playTone(frequency, duration, type = "sine", volume = 0.03, delay = 0) {
  if (!soundEnabled || !audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const start = audioContext.currentTime + delay;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + duration);
}

function playGoalSound() {
  [220, 330, 440, 660].forEach((frequency, index) => playTone(frequency, 0.2, "square", 0.025, index * 0.07));
}

function showMessage(text, duration = 900) {
  messageElement.textContent = text;
  messageElement.classList.add("show");
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => messageElement.classList.remove("show"), duration);
}

function showToast(text) {
  toastElement.textContent = text;
  toastElement.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove("show"), 2600);
}

function roomStatusLabel(status) {
  return {
    waiting: "WAITING",
    countdown: "STARTING",
    playing: "PLAYING",
    goldenGoal: "GOLDEN GOAL",
    ended: "ENDED",
  }[status] || String(status).toUpperCase();
}

function endReasonText(reason) {
  return {
    regulation: "정규시간 승리",
    "golden-goal": "골든골 승리",
    disconnect: "상대 연결 종료로 승리",
    forfeit: "상대 포기로 승리",
  }[reason] || "경기가 종료됐습니다.";
}

function sanitizeText(value, maximum, fallback) {
  const safe = String(value ?? "").replace(/[<>&"'`\\]/g, "").trim().slice(0, maximum);
  return safe || fallback;
}

function sanitizePlayerNumber(value) {
  const safe = String(value ?? "").trim().toUpperCase();
  if (/^[가-힣]$/.test(safe)) return safe;
  if (/^[A-Z0-9]{1,2}$/.test(safe)) return safe;
  return "10";
}

function cloneState(value) {
  return JSON.parse(JSON.stringify(value));
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

window.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyX", "ControlLeft", "ControlRight", "Space"].includes(event.code)) {
    event.preventDefault();
    const wasPressed = keys.has(event.code);
    keys.add(event.code);
    if (!wasPressed && ["KeyX", "ControlLeft", "ControlRight", "Space"].includes(event.code)) {
      predictLocalKick();
    }
    sendInput();
  }
});
window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
  sendInput();
});
window.addEventListener("blur", () => keys.clear());
createRoomForm.addEventListener("submit", createRoom);
refreshButton.addEventListener("click", () => loadRooms(true));
leaveButton.addEventListener("click", leaveRoom);
soundButton.addEventListener("click", toggleSound);
nicknameInput.addEventListener("change", saveNickname);
playerNumberInput.addEventListener("change", () => savePlayerNumber(true));

loadRooms(true);
roomPollTimer = setInterval(loadRooms, 2500);
requestAnimationFrame(animate);
