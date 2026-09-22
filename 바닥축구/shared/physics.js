export const WORLD = Object.freeze({
  width: 1280,
  height: 720,
  field: { left: 90, right: 1190, top: 76, bottom: 644 },
  goal: { top: 260, bottom: 460, depth: 58 },
  playerRadius: 23,
  ballRadius: 13,
  playerLineMargin: 40,
});

const PLAYER_ACCELERATION = 1500;
const PLAYER_MAX_SPEED = 330;
const KICK_POWER = 565;
const KICK_RANGE_BONUS = 22;
const KICK_COOLDOWN = 0.36;
const GOAL_PAUSE_SECONDS = 1.65;
const COUNTDOWN_SECONDS = 3;
const FIXED_MAX_STEP = 1 / 120;

export function createMatch(config = {}) {
  const teamSize = clampInt(config.teamSize, 1, 4, 1);
  const durationMinutes = clampInt(config.durationMinutes, 1, 10, 2);

  return {
    version: 1,
    status: "waiting",
    teamSize,
    durationMinutes,
    remainingSeconds: durationMinutes * 60,
    countdownSeconds: COUNTDOWN_SECONDS,
    countdownReason: "initial",
    goalPauseSeconds: 0,
    pendingWinner: null,
    goldenGoal: false,
    winner: null,
    winReason: null,
    scores: { blue: 0, red: 0 },
    tick: 0,
    players: [],
    ball: createBall(),
  };
}

export function addMatchPlayer(state, player) {
  if (state.players.some((entry) => entry.id === player.id)) return null;
  if (state.players.length >= state.teamSize * 2) return null;

  const team = pickBalancedTeam(state.players, state.teamSize);
  if (!team) return null;
  const slot = firstOpenSlot(state.players, team, state.teamSize);
  const position = spawnPosition(team, slot, state.teamSize);
  const nextPlayer = {
    id: player.id,
    name: sanitizeName(player.name),
    number: sanitizeNumber(player.number),
    team,
    slot,
    connected: true,
    x: position.x,
    y: position.y,
    vx: 0,
    vy: 0,
    radius: WORLD.playerRadius,
    facingX: team === "blue" ? 1 : -1,
    facingY: 0,
    kickCooldown: 0,
    kickFlash: 0,
    input: { up: false, down: false, left: false, right: false, kick: false, sequence: 0 },
    previousKick: false,
  };
  state.players.push(nextPlayer);
  return nextPlayer;
}

export function removeMatchPlayer(state, playerId) {
  const index = state.players.findIndex((player) => player.id === playerId);
  if (index < 0) return false;
  state.players.splice(index, 1);
  return true;
}

export function setPlayerConnected(state, playerId, connected) {
  const player = state.players.find((entry) => entry.id === playerId);
  if (!player) return false;
  player.connected = connected;
  if (!connected) {
    player.input = { up: false, down: false, left: false, right: false, kick: false, sequence: player.input.sequence };
  }
  return true;
}

export function setPlayerInput(state, playerId, input) {
  const player = state.players.find((entry) => entry.id === playerId);
  if (!player || !input || !Number.isFinite(input.sequence)) return false;
  if (input.sequence <= player.input.sequence) return false;
  player.input = {
    up: input.up === true,
    down: input.down === true,
    left: input.left === true,
    right: input.right === true,
    kick: input.kick === true,
    sequence: Math.floor(input.sequence),
  };
  return true;
}

export function canStartMatch(state) {
  return (
    state.status === "waiting" &&
    state.players.filter((player) => player.connected).length === state.teamSize * 2 &&
    countTeam(state.players, "blue", true) === state.teamSize &&
    countTeam(state.players, "red", true) === state.teamSize
  );
}

export function startMatchCountdown(state) {
  if (!canStartMatch(state)) return false;
  state.status = "countdown";
  state.countdownSeconds = COUNTDOWN_SECONDS;
  state.countdownReason = "initial";
  resetPositions(state);
  return true;
}

export function stepMatch(state, dt) {
  if (!Number.isFinite(dt) || dt <= 0) return;
  const safeDt = Math.min(dt, 0.1);

  if (state.status === "countdown") {
    state.countdownSeconds = Math.max(0, state.countdownSeconds - safeDt);
    if (state.countdownSeconds <= 0) state.status = state.goldenGoal ? "goldenGoal" : "playing";
    state.tick += 1;
    return;
  }

  if (state.status === "goal") {
    stepLivePhysics(state, safeDt, false);
    state.goalPauseSeconds = Math.max(0, state.goalPauseSeconds - safeDt);
    if (state.goalPauseSeconds <= 0) {
      if (state.pendingWinner) {
        finishMatch(state, state.pendingWinner, state.goldenGoal ? "golden-goal" : "regulation");
      } else {
        resetPositions(state);
        state.status = "countdown";
        state.countdownSeconds = 0.65;
        state.countdownReason = "restart";
      }
    }
    state.tick += 1;
    return;
  }

  if (state.status !== "playing" && state.status !== "goldenGoal") return;

  if (state.status === "playing") {
    state.remainingSeconds = Math.max(0, state.remainingSeconds - safeDt);
    if (state.remainingSeconds <= 0) {
      if (state.scores.blue === state.scores.red) {
        state.status = "goldenGoal";
        state.goldenGoal = true;
      } else {
        const winner = state.scores.blue > state.scores.red ? "blue" : "red";
        finishMatch(state, winner, "regulation");
        state.tick += 1;
        return;
      }
    }
  }

  stepLivePhysics(state, safeDt, true);
  state.tick += 1;
}

export function finishMatch(state, winner, reason = "forfeit") {
  state.status = "ended";
  state.winner = winner;
  state.winReason = reason;
  state.pendingWinner = null;
  state.players.forEach((player) => {
    player.input = { ...player.input, up: false, down: false, left: false, right: false, kick: false };
    player.vx = 0;
    player.vy = 0;
  });
}

export function serializeMatch(state) {
  return {
    version: state.version,
    status: state.status,
    teamSize: state.teamSize,
    durationMinutes: state.durationMinutes,
    remainingSeconds: state.remainingSeconds,
    countdownSeconds: state.countdownSeconds,
    countdownReason: state.countdownReason,
    goalPauseSeconds: state.goalPauseSeconds,
    goldenGoal: state.goldenGoal,
    winner: state.winner,
    winReason: state.winReason,
    lastGoalTeam: state.lastGoalTeam ?? null,
    lastGoalSide: state.lastGoalSide ?? null,
    scores: state.scores,
    tick: state.tick,
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      number: player.number,
      team: player.team,
      slot: player.slot,
      connected: player.connected,
      x: player.x,
      y: player.y,
      vx: player.vx,
      vy: player.vy,
      radius: player.radius,
      facingX: player.facingX,
      facingY: player.facingY,
      kickFlash: player.kickFlash,
    })),
    ball: {
      x: state.ball.x,
      y: state.ball.y,
      vx: state.ball.vx,
      vy: state.ball.vy,
      radius: state.ball.radius,
    },
  };
}

function stepLivePhysics(state, dt, allowGoal) {
  const substeps = Math.max(1, Math.ceil(dt / FIXED_MAX_STEP));
  const subDt = dt / substeps;

  for (let step = 0; step < substeps; step += 1) {
    state.players.forEach((player) => updatePlayer(player, state, subDt));

    for (let iteration = 0; iteration < 2; iteration += 1) {
      for (let i = 0; i < state.players.length; i += 1) {
        for (let j = i + 1; j < state.players.length; j += 1) {
          resolvePlayerPair(state.players[i], state.players[j]);
        }
      }
      state.players.forEach(constrainPlayer);
    }

    moveBall(state.ball, subDt);
    constrainBallToWorld(state, allowGoal);

    state.players.forEach((player) => resolveBallPlayer(state.ball, player));

    for (let iteration = 0; iteration < 3; iteration += 1) {
      constrainBallToWorld(state, allowGoal);
      state.players.forEach((player) => resolveResidualOverlap(state.ball, player));
    }

    if (state.status === "goal" || state.status === "ended") break;
  }
}

function updatePlayer(player, state, dt) {
  const input = player.connected ? player.input : {};
  let inputX = Number(input.right === true) - Number(input.left === true);
  let inputY = Number(input.down === true) - Number(input.up === true);
  const length = Math.hypot(inputX, inputY);

  if (length > 0) {
    inputX /= length;
    inputY /= length;
    player.facingX = inputX;
    player.facingY = inputY;
  }

  player.vx += inputX * PLAYER_ACCELERATION * dt;
  player.vy += inputY * PLAYER_ACCELERATION * dt;
  const drag = Math.pow(length > 0 ? 0.0008 : 0.00002, dt);
  player.vx *= drag;
  player.vy *= drag;

  const speed = Math.hypot(player.vx, player.vy);
  if (speed > PLAYER_MAX_SPEED) {
    player.vx = (player.vx / speed) * PLAYER_MAX_SPEED;
    player.vy = (player.vy / speed) * PLAYER_MAX_SPEED;
  }

  player.x += player.vx * dt;
  player.y += player.vy * dt;
  constrainPlayer(player);

  player.kickCooldown = Math.max(0, player.kickCooldown - dt);
  player.kickFlash = Math.max(0, player.kickFlash - dt);
  const kickPressed = input.kick === true;
  if (kickPressed && !player.previousKick && player.kickCooldown <= 0) {
    tryKick(state.ball, player);
  }
  player.previousKick = kickPressed;
}

function tryKick(ball, player) {
  player.kickCooldown = KICK_COOLDOWN;
  const dx = ball.x - player.x;
  const dy = ball.y - player.y;
  const distance = Math.hypot(dx, dy);
  if (distance > player.radius + ball.radius + KICK_RANGE_BONUS) return false;

  const nx = distance > 0.0001 ? dx / distance : player.facingX;
  const ny = distance > 0.0001 ? dy / distance : player.facingY;
  const aimX = nx * 0.58 + player.facingX * 0.42;
  const aimY = ny * 0.58 + player.facingY * 0.42;
  const aimLength = Math.hypot(aimX, aimY) || 1;
  ball.vx = (aimX / aimLength) * KICK_POWER + player.vx * 0.18;
  ball.vy = (aimY / aimLength) * KICK_POWER + player.vy * 0.18;
  player.kickFlash = 0.16;
  return true;
}

function moveBall(ball, dt) {
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  const drag = Math.pow(0.36, dt);
  ball.vx *= drag;
  ball.vy *= drag;
}

function resolveBallPlayer(ball, player) {
  let dx = ball.x - player.x;
  let dy = ball.y - player.y;
  let distance = Math.hypot(dx, dy);
  const minimum = ball.radius + player.radius;
  if (distance >= minimum) return;

  if (distance < 0.0001) {
    dx = player.facingX || (player.team === "blue" ? 1 : -1);
    dy = player.facingY || 0;
    distance = Math.hypot(dx, dy) || 1;
  }

  const nx = dx / distance;
  const ny = dy / distance;
  const overlap = minimum - distance;
  ball.x += nx * overlap * 0.72;
  ball.y += ny * overlap * 0.72;
  player.x -= nx * overlap * 0.28;
  player.y -= ny * overlap * 0.28;

  const relativeNormal = (ball.vx - player.vx) * nx + (ball.vy - player.vy) * ny;
  if (relativeNormal < 0) {
    const impulse = -relativeNormal * 0.82;
    ball.vx += nx * impulse;
    ball.vy += ny * impulse;
    player.vx -= nx * impulse * 0.06;
    player.vy -= ny * impulse * 0.06;
  }
  constrainPlayer(player);
}

function resolveResidualOverlap(ball, player) {
  let dx = ball.x - player.x;
  let dy = ball.y - player.y;
  let distance = Math.hypot(dx, dy);
  const minimum = ball.radius + player.radius + 0.02;
  if (distance >= minimum) return;

  if (distance < 0.0001) {
    dx = player.facingX || 1;
    dy = player.facingY || 0;
    distance = Math.hypot(dx, dy) || 1;
  }

  const nx = dx / distance;
  const ny = dy / distance;
  const overlap = minimum - distance;
  const beforeX = ball.x;
  const beforeY = ball.y;
  ball.x += nx * overlap;
  ball.y += ny * overlap;
  clampBallToPitch(ball);

  const movedTowardX = (ball.x - beforeX) * nx;
  const movedTowardY = (ball.y - beforeY) * ny;
  const effectiveMovement = Math.max(0, movedTowardX + movedTowardY);
  const remainder = Math.max(0, overlap - effectiveMovement);
  if (remainder > 0) {
    player.x -= nx * remainder;
    player.y -= ny * remainder;
    constrainPlayer(player);
  }
}

function resolvePlayerPair(a, b) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let distance = Math.hypot(dx, dy);
  const minimum = a.radius + b.radius;
  if (distance >= minimum) return;
  if (distance < 0.0001) {
    dx = a.id < b.id ? 1 : -1;
    dy = 0;
    distance = 1;
  }
  const nx = dx / distance;
  const ny = dy / distance;
  const overlap = minimum - distance;
  a.x -= nx * overlap * 0.5;
  a.y -= ny * overlap * 0.5;
  b.x += nx * overlap * 0.5;
  b.y += ny * overlap * 0.5;

  const relative = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (relative < 0) {
    const impulse = relative * 0.36;
    a.vx += nx * impulse;
    a.vy += ny * impulse;
    b.vx -= nx * impulse;
    b.vy -= ny * impulse;
  }
}

function constrainPlayer(player) {
  const { field, goal, playerLineMargin } = WORLD;
  player.x = clamp(player.x, field.left - playerLineMargin, field.right + playerLineMargin);
  player.y = clamp(player.y, field.top - playerLineMargin, field.bottom + playerLineMargin);

  constrainPlayerInGoal(player, field.left, -1);
  constrainPlayerInGoal(player, field.right, 1);
  resolveCirclePost(player, field.left, goal.top, 8, 0);
  resolveCirclePost(player, field.left, goal.bottom, 8, 0);
  resolveCirclePost(player, field.right, goal.top, 8, 0);
  resolveCirclePost(player, field.right, goal.bottom, 8, 0);
}

function constrainPlayerInGoal(player, front, direction) {
  const { goal } = WORLD;
  const behind = direction < 0 ? player.x < front : player.x > front;
  const inMouth = player.y > goal.top && player.y < goal.bottom;
  if (!behind || !inMouth) return;
  const back = front + goal.depth * direction;
  player.x = direction < 0
    ? Math.max(back + player.radius, player.x)
    : Math.min(back - player.radius, player.x);
  player.y = clamp(player.y, goal.top + player.radius, goal.bottom - player.radius);
}

function constrainBallToWorld(state, allowGoal) {
  const ball = state.ball;
  const { field, goal } = WORLD;

  if (state.status === "goal") {
    constrainBallInScoredGoal(state);
    return;
  }

  if (ball.y - ball.radius < field.top) {
    ball.y = field.top + ball.radius;
    ball.vy = Math.abs(ball.vy) * 0.52;
  } else if (ball.y + ball.radius > field.bottom) {
    ball.y = field.bottom - ball.radius;
    ball.vy = -Math.abs(ball.vy) * 0.52;
  }

  const inMouth = ball.y > goal.top + ball.radius * 0.15 && ball.y < goal.bottom - ball.radius * 0.15;
  if (!inMouth) {
    if (ball.x - ball.radius < field.left) {
      ball.x = field.left + ball.radius;
      ball.vx = Math.abs(ball.vx) * 0.52;
    } else if (ball.x + ball.radius > field.right) {
      ball.x = field.right - ball.radius;
      ball.vx = -Math.abs(ball.vx) * 0.52;
    }
  } else if (allowGoal) {
    if (ball.x < field.left - ball.radius * 0.3) registerGoal(state, "red", "left");
    if (ball.x > field.right + ball.radius * 0.3) registerGoal(state, "blue", "right");
  }

  resolveCirclePost(ball, field.left, goal.top, 8, 0.82);
  resolveCirclePost(ball, field.left, goal.bottom, 8, 0.82);
  resolveCirclePost(ball, field.right, goal.top, 8, 0.82);
  resolveCirclePost(ball, field.right, goal.bottom, 8, 0.82);
}

function clampBallToPitch(ball) {
  const { field, goal } = WORLD;
  ball.y = clamp(ball.y, field.top + ball.radius, field.bottom - ball.radius);
  const inMouth = ball.y > goal.top + ball.radius * 0.15 && ball.y < goal.bottom - ball.radius * 0.15;
  if (!inMouth) ball.x = clamp(ball.x, field.left + ball.radius, field.right - ball.radius);
}

function constrainBallInScoredGoal(state) {
  const ball = state.ball;
  const { field, goal } = WORLD;
  const isRight = state.lastGoalSide === "right";
  const front = isRight ? field.right : field.left;
  const back = front + (isRight ? goal.depth : -goal.depth);
  const minimumX = Math.min(front, back) + ball.radius;
  const maximumX = Math.max(front, back) - ball.radius;

  if (ball.x < minimumX) {
    ball.x = minimumX;
    ball.vx = Math.abs(ball.vx) * 0.48;
  } else if (ball.x > maximumX) {
    ball.x = maximumX;
    ball.vx = -Math.abs(ball.vx) * 0.48;
  }
  if (ball.y - ball.radius < goal.top) {
    ball.y = goal.top + ball.radius;
    ball.vy = Math.abs(ball.vy) * 0.48;
  } else if (ball.y + ball.radius > goal.bottom) {
    ball.y = goal.bottom - ball.radius;
    ball.vy = -Math.abs(ball.vy) * 0.48;
  }
}

function resolveCirclePost(circle, x, y, postRadius, restitution) {
  let dx = circle.x - x;
  let dy = circle.y - y;
  let distance = Math.hypot(dx, dy);
  const minimum = circle.radius + postRadius;
  if (distance >= minimum) return;
  if (distance < 0.0001) {
    dx = 1;
    dy = 0;
    distance = 1;
  }
  const nx = dx / distance;
  const ny = dy / distance;
  circle.x = x + nx * minimum;
  circle.y = y + ny * minimum;
  const velocity = circle.vx * nx + circle.vy * ny;
  if (velocity < 0) {
    circle.vx -= (1 + restitution) * velocity * nx;
    circle.vy -= (1 + restitution) * velocity * ny;
  }
}

function registerGoal(state, team, side) {
  if (state.status === "goal" || state.status === "ended") return;
  state.scores[team] += 1;
  state.lastGoalTeam = team;
  state.lastGoalSide = side;
  state.status = "goal";
  state.goalPauseSeconds = GOAL_PAUSE_SECONDS;
  state.pendingWinner = state.goldenGoal ? team : null;
}

function resetPositions(state) {
  state.players.forEach((player) => {
    const position = spawnPosition(player.team, player.slot, state.teamSize);
    player.x = position.x;
    player.y = position.y;
    player.vx = 0;
    player.vy = 0;
    player.facingX = player.team === "blue" ? 1 : -1;
    player.facingY = 0;
    player.kickCooldown = 0;
    player.kickFlash = 0;
    player.previousKick = player.input.kick;
  });
  state.ball = createBall();
  state.pendingWinner = null;
}

function createBall() {
  return {
    x: WORLD.width / 2,
    y: WORLD.height / 2,
    vx: 0,
    vy: 0,
    radius: WORLD.ballRadius,
  };
}

function spawnPosition(team, slot, teamSize) {
  const usableHeight = WORLD.field.bottom - WORLD.field.top;
  const y = WORLD.field.top + ((slot + 1) * usableHeight) / (teamSize + 1);
  return { x: team === "blue" ? 340 : 940, y };
}

function pickBalancedTeam(players, teamSize) {
  const blue = countTeam(players, "blue");
  const red = countTeam(players, "red");
  if (blue >= teamSize && red >= teamSize) return null;
  if (blue >= teamSize) return "red";
  if (red >= teamSize) return "blue";
  return blue <= red ? "blue" : "red";
}

function firstOpenSlot(players, team, teamSize) {
  for (let slot = 0; slot < teamSize; slot += 1) {
    if (!players.some((player) => player.team === team && player.slot === slot)) return slot;
  }
  return -1;
}

function countTeam(players, team, connectedOnly = false) {
  return players.filter((player) => player.team === team && (!connectedOnly || player.connected)).length;
}

function sanitizeName(value) {
  const safe = String(value ?? "PLAYER").replace(/[<>&"'`]/g, "").trim().slice(0, 16);
  return safe || "PLAYER";
}

function sanitizeNumber(value) {
  const safe = String(value ?? "").trim().toUpperCase();
  if (/^[가-힣]$/.test(safe)) return safe;
  if (/^[A-Z0-9]{1,2}$/.test(safe)) return safe;
  return "10";
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clampInt(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}
