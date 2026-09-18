const canvas = document.querySelector("#gameCanvas");
const ctx = canvas.getContext("2d");
const startButton = document.querySelector("#startButton");
const startOverlay = document.querySelector("#startOverlay");
const message = document.querySelector("#message");
const blueScoreElement = document.querySelector("#blueScore");
const redScoreElement = document.querySelector("#redScore");
const timerElement = document.querySelector("#timer");
const soundButton = document.querySelector("#soundButton");

const WIDTH = canvas.width;
const HEIGHT = canvas.height;
const field = { left: 90, right: 1190, top: 76, bottom: 644 };
const goal = { top: 260, bottom: 460, depth: 58 };
const PLAYER_RADIUS = 23;
const BALL_RADIUS = 13;
const MATCH_SECONDS = 120;
const WIN_SCORE = 5;
const PLAYER_LINE_MARGIN = 40;

const keys = new Set();
const particles = [];
let audioContext = null;
let soundEnabled = false;
let lastTime = performance.now();
let matchTime = MATCH_SECONDS;
let gameState = "menu";
let kickoffUntil = 0;
let goalMoment = null;
let shake = 0;
let messageTimer = 0;

const teams = {
  blue: { score: 0, color: "#24c8ff", dark: "#087ea3" },
  red: { score: 0, color: "#ff416d", dark: "#a9153a" },
};

const players = [
  createPlayer("blue", 355, HEIGHT / 2, {
    up: "KeyW",
    down: "KeyS",
    left: "KeyA",
    right: "KeyD",
    kick: "Space",
  }),
  createPlayer("red", 925, HEIGHT / 2, {
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    kick: "Enter",
  }),
];

const ball = {
  x: WIDTH / 2,
  y: HEIGHT / 2,
  vx: 0,
  vy: 0,
  radius: BALL_RADIUS,
  trail: [],
};

function createPlayer(team, x, y, controls) {
  return {
    team,
    x,
    y,
    vx: 0,
    vy: 0,
    radius: PLAYER_RADIUS,
    controls,
    facingX: team === "blue" ? 1 : -1,
    facingY: 0,
    kickCooldown: 0,
    kickFlash: 0,
  };
}

function resetPositions() {
  Object.assign(players[0], { x: 355, y: HEIGHT / 2, vx: 0, vy: 0, facingX: 1, facingY: 0 });
  Object.assign(players[1], { x: 925, y: HEIGHT / 2, vx: 0, vy: 0, facingX: -1, facingY: 0 });
  Object.assign(ball, { x: WIDTH / 2, y: HEIGHT / 2, vx: 0, vy: 0, trail: [] });
}

function startMatch() {
  teams.blue.score = 0;
  teams.red.score = 0;
  matchTime = MATCH_SECONDS;
  gameState = "playing";
  goalMoment = null;
  kickoffUntil = performance.now() + 650;
  resetPositions();
  updateHud();
  startOverlay.classList.add("hidden");
  showMessage("KICK OFF!", 750);
  playTone(220, 0.08, "square", 0.035);
}

function updateHud() {
  blueScoreElement.textContent = teams.blue.score;
  redScoreElement.textContent = teams.red.score;
  const seconds = Math.max(0, Math.ceil(matchTime));
  timerElement.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function showMessage(text, duration = 900) {
  message.textContent = text;
  message.classList.add("show");
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => message.classList.remove("show"), duration);
}

function scoreGoal(teamName) {
  if (gameState !== "playing" || goalMoment) return;

  const now = performance.now();
  teams[teamName].score += 1;
  goalMoment = {
    team: teamName,
    side: teamName === "blue" ? "right" : "left",
    startedAt: now,
    endAt: now + 1650,
    winner: teams[teamName].score >= WIN_SCORE ? teamName : null,
  };
  updateHud();
  shake = 24;
  createBurst(ball.x, ball.y, teams[teamName].color, 46);
  showMessage(`${teamName.toUpperCase()} GOAL!`, 1350);
  playGoalSound();
}

function endMatch(winner = null) {
  gameState = "ended";
  kickoffUntil = Infinity;
  goalMoment = null;
  const winnerName =
    winner ?? (teams.blue.score === teams.red.score ? "draw" : teams.blue.score > teams.red.score ? "blue" : "red");

  if (winnerName === "draw") {
    showEndOverlay("무승부!", "끝까지 팽팽했던 경기였습니다.");
  } else {
    showEndOverlay(`${winnerName.toUpperCase()} WINS!`, `${teams[winnerName].score}골로 경기를 가져갑니다.`);
  }
}

function showEndOverlay(title, description) {
  startOverlay.querySelector(".eyebrow").textContent = "FULL TIME";
  startOverlay.querySelector("h2").textContent = title;
  startOverlay.querySelector(".lead").textContent = description;
  startButton.firstChild.textContent = "REMATCH ";
  startOverlay.classList.remove("hidden");
  playTone(130, 0.35, "sawtooth", 0.025);
}

function updatePlayer(player, dt) {
  const c = player.controls;
  let inputX = Number(keys.has(c.right)) - Number(keys.has(c.left));
  let inputY = Number(keys.has(c.down)) - Number(keys.has(c.up));
  const inputLength = Math.hypot(inputX, inputY);

  if (inputLength) {
    inputX /= inputLength;
    inputY /= inputLength;
    player.facingX = inputX;
    player.facingY = inputY;
  }

  const acceleration = 1500;
  player.vx += inputX * acceleration * dt;
  player.vy += inputY * acceleration * dt;

  const drag = Math.pow(inputLength ? 0.0008 : 0.00002, dt);
  player.vx *= drag;
  player.vy *= drag;

  const speed = Math.hypot(player.vx, player.vy);
  const maxSpeed = 330;
  if (speed > maxSpeed) {
    player.vx = (player.vx / speed) * maxSpeed;
    player.vy = (player.vy / speed) * maxSpeed;
  }

  player.x += player.vx * dt;
  player.y += player.vy * dt;
  constrainPlayer(player);
  player.kickCooldown = Math.max(0, player.kickCooldown - dt);
  player.kickFlash = Math.max(0, player.kickFlash - dt);

  if (keys.has(c.kick) && player.kickCooldown <= 0) {
    kickBall(player);
  }
}

function constrainPlayer(player) {
  player.x = Math.max(
    field.left - PLAYER_LINE_MARGIN,
    Math.min(field.right + PLAYER_LINE_MARGIN, player.x),
  );
  player.y = Math.max(
    field.top - PLAYER_LINE_MARGIN,
    Math.min(field.bottom + PLAYER_LINE_MARGIN, player.y),
  );

  constrainPlayerInGoal(player, field.left, -1);
  constrainPlayerInGoal(player, field.right, 1);
  resolvePlayerPost(player, field.left, goal.top);
  resolvePlayerPost(player, field.left, goal.bottom);
  resolvePlayerPost(player, field.right, goal.top);
  resolvePlayerPost(player, field.right, goal.bottom);
}

function constrainPlayerInGoal(player, front, direction) {
  const behindGoalLine = direction < 0 ? player.x < front : player.x > front;
  const insideGoalMouth = player.y > goal.top && player.y < goal.bottom;
  if (!behindGoalLine || !insideGoalMouth) return;

  const back = front + goal.depth * direction;
  if (direction < 0) {
    player.x = Math.max(back + player.radius, player.x);
  } else {
    player.x = Math.min(back - player.radius, player.x);
  }
  player.y = Math.max(goal.top + player.radius, Math.min(goal.bottom - player.radius, player.y));
}

function resolvePlayerPost(player, x, y) {
  const postRadius = 8;
  const dx = player.x - x;
  const dy = player.y - y;
  const distance = Math.hypot(dx, dy);
  const minDistance = player.radius + postRadius;
  if (distance >= minDistance || distance === 0) return;

  const nx = dx / distance;
  const ny = dy / distance;
  player.x = x + nx * minDistance;
  player.y = y + ny * minDistance;

  const inwardSpeed = player.vx * nx + player.vy * ny;
  if (inwardSpeed < 0) {
    player.vx -= inwardSpeed * nx;
    player.vy -= inwardSpeed * ny;
  }
}

function kickBall(player) {
  player.kickCooldown = 0.42;
  const dx = ball.x - player.x;
  const dy = ball.y - player.y;
  const distance = Math.hypot(dx, dy);
  const kickRange = player.radius + ball.radius + 24;

  if (distance > kickRange) {
    playTone(85, 0.025, "square", 0.008);
    return;
  }

  const nx = distance > 0 ? dx / distance : player.facingX;
  const ny = distance > 0 ? dy / distance : player.facingY;
  const aimX = nx * 0.65 + player.facingX * 0.35;
  const aimY = ny * 0.65 + player.facingY * 0.35;
  const aimLength = Math.hypot(aimX, aimY) || 1;
  const power = 610;

  ball.vx = (aimX / aimLength) * power + player.vx * 0.22;
  ball.vy = (aimY / aimLength) * power + player.vy * 0.22;
  player.kickFlash = 0.15;
  shake = Math.max(shake, 4);
  createBurst(ball.x, ball.y, teams[player.team].color, 8);
  playTone(105, 0.07, "triangle", 0.05);
}

function resolvePlayerCollision(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  const minDistance = a.radius + b.radius;
  if (distance >= minDistance || distance === 0) return;

  const nx = dx / distance;
  const ny = dy / distance;
  const overlap = minDistance - distance;
  a.x -= nx * overlap * 0.5;
  a.y -= ny * overlap * 0.5;
  b.x += nx * overlap * 0.5;
  b.y += ny * overlap * 0.5;

  const relativeVelocity = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (relativeVelocity < 0) {
    const impulse = relativeVelocity * 0.42;
    a.vx += nx * impulse;
    a.vy += ny * impulse;
    b.vx -= nx * impulse;
    b.vy -= ny * impulse;
  }
}

function resolveBallPlayerCollision(player) {
  const dx = ball.x - player.x;
  const dy = ball.y - player.y;
  const distance = Math.hypot(dx, dy);
  const minDistance = ball.radius + player.radius;
  if (distance >= minDistance || distance === 0) return;

  const nx = dx / distance;
  const ny = dy / distance;
  const overlap = minDistance - distance;
  ball.x += nx * overlap;
  ball.y += ny * overlap;

  const relativeVelocity = (ball.vx - player.vx) * nx + (ball.vy - player.vy) * ny;
  if (relativeVelocity < 0) {
    const impulse = -relativeVelocity * 1.42;
    ball.vx += nx * impulse + player.vx * 0.08;
    ball.vy += ny * impulse + player.vy * 0.08;
  }
}

function updateBall(dt) {
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  const drag = Math.pow(0.42, dt);
  ball.vx *= drag;
  ball.vy *= drag;

  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > 90) {
    ball.trail.unshift({ x: ball.x, y: ball.y, life: Math.min(1, speed / 700) });
    if (ball.trail.length > 11) ball.trail.pop();
  } else if (ball.trail.length) {
    ball.trail.pop();
  }

  if (goalMoment) {
    updateBallInNet();
    return;
  }

  const inGoalMouth = ball.y > goal.top + ball.radius * 0.15 && ball.y < goal.bottom - ball.radius * 0.15;

  if (ball.y - ball.radius < field.top) {
    ball.y = field.top + ball.radius;
    ball.vy = Math.abs(ball.vy) * 0.84;
    wallHit();
  } else if (ball.y + ball.radius > field.bottom) {
    ball.y = field.bottom - ball.radius;
    ball.vy = -Math.abs(ball.vy) * 0.84;
    wallHit();
  }

  if (!inGoalMouth) {
    if (ball.x - ball.radius < field.left) {
      ball.x = field.left + ball.radius;
      ball.vx = Math.abs(ball.vx) * 0.84;
      wallHit();
    } else if (ball.x + ball.radius > field.right) {
      ball.x = field.right - ball.radius;
      ball.vx = -Math.abs(ball.vx) * 0.84;
      wallHit();
    }
  } else {
    if (ball.x < field.left - ball.radius * 0.3) scoreGoal("red");
    if (ball.x > field.right + ball.radius * 0.3) scoreGoal("blue");
  }

  resolvePost(field.left, goal.top);
  resolvePost(field.left, goal.bottom);
  resolvePost(field.right, goal.top);
  resolvePost(field.right, goal.bottom);
}

function updateBallInNet() {
  const isRight = goalMoment.side === "right";
  const front = isRight ? field.right : field.left;
  const back = front + (isRight ? goal.depth : -goal.depth);
  const minX = Math.min(front, back) + ball.radius;
  const maxX = Math.max(front, back) - ball.radius;
  let netHit = false;

  if (ball.x < minX) {
    ball.x = minX;
    ball.vx = Math.abs(ball.vx) * 0.56;
    netHit = true;
  } else if (ball.x > maxX) {
    ball.x = maxX;
    ball.vx = -Math.abs(ball.vx) * 0.56;
    netHit = true;
  }

  if (ball.y - ball.radius < goal.top) {
    ball.y = goal.top + ball.radius;
    ball.vy = Math.abs(ball.vy) * 0.56;
    netHit = true;
  } else if (ball.y + ball.radius > goal.bottom) {
    ball.y = goal.bottom - ball.radius;
    ball.vy = -Math.abs(ball.vy) * 0.56;
    netHit = true;
  }

  if (netHit) {
    createBurst(ball.x, ball.y, "rgba(235, 255, 240, 0.7)", 3);
    shake = Math.max(shake, 4);
    playTone(72, 0.035, "triangle", 0.016);
  }
}

function resolvePost(x, y) {
  const postRadius = 8;
  const dx = ball.x - x;
  const dy = ball.y - y;
  const distance = Math.hypot(dx, dy);
  const minDistance = ball.radius + postRadius;
  if (distance >= minDistance || distance === 0) return;

  const nx = dx / distance;
  const ny = dy / distance;
  ball.x = x + nx * minDistance;
  ball.y = y + ny * minDistance;
  const dot = ball.vx * nx + ball.vy * ny;
  if (dot < 0) {
    ball.vx -= 1.85 * dot * nx;
    ball.vy -= 1.85 * dot * ny;
    wallHit(true);
  }
}

function wallHit(post = false) {
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > 180) {
    shake = Math.max(shake, post ? 5 : 2);
    playTone(post ? 210 : 155, 0.025, "square", Math.min(0.025, speed / 35000));
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

function createBurst(x, y, color, count) {
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 70 + Math.random() * 320;
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

function update(dt, now) {
  updateParticles(dt);
  if (gameState !== "playing") return;

  if (goalMoment) {
    players.forEach((player) => updatePlayer(player, dt));
    resolvePlayerCollision(players[0], players[1]);
    players.forEach(constrainPlayer);
    players.forEach(resolveBallPlayerCollision);
    updateBall(dt);

    if (now >= goalMoment.endAt) {
      const winner = goalMoment.winner;
      goalMoment = null;
      if (winner) {
        endMatch(winner);
      } else {
        resetPositions();
        kickoffUntil = now + 500;
        showMessage("PLAY!", 480);
      }
    }
    return;
  }

  if (now < kickoffUntil) return;

  matchTime -= dt;
  if (matchTime <= 0) {
    matchTime = 0;
    updateHud();
    endMatch();
    return;
  }

  players.forEach((player) => updatePlayer(player, dt));
  resolvePlayerCollision(players[0], players[1]);
  players.forEach(constrainPlayer);
  players.forEach(resolveBallPlayerCollision);
  updateBall(dt);
  updateHud();
}

function draw() {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.save();

  if (shake > 0.2) {
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    shake *= 0.88;
  } else {
    shake = 0;
  }

  drawBackground();
  drawGoals();
  drawField();
  drawBallTrail();
  players.forEach(drawPlayer);
  drawBall();
  drawParticles();
  ctx.restore();
}

function drawBackground() {
  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, "#07121a");
  gradient.addColorStop(0.5, "#0b1115");
  gradient.addColorStop(1, "#160a10");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.strokeStyle = "rgba(255,255,255,0.018)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= WIDTH; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, HEIGHT);
    ctx.stroke();
  }
  for (let y = 0; y <= HEIGHT; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WIDTH, y);
    ctx.stroke();
  }
}

function drawField() {
  const pitchGradient = ctx.createLinearGradient(field.left, 0, field.right, 0);
  pitchGradient.addColorStop(0, "rgba(20, 61, 68, 0.78)");
  pitchGradient.addColorStop(0.5, "rgba(21, 48, 47, 0.78)");
  pitchGradient.addColorStop(1, "rgba(63, 29, 42, 0.74)");
  ctx.fillStyle = pitchGradient;
  ctx.fillRect(field.left, field.top, field.right - field.left, field.bottom - field.top);

  for (let x = field.left; x < field.right; x += 110) {
    ctx.fillStyle = x / 110 % 2 < 1 ? "rgba(255,255,255,0.012)" : "rgba(0,0,0,0.018)";
    ctx.fillRect(x, field.top, 110, field.bottom - field.top);
  }

  ctx.strokeStyle = "rgba(217, 255, 227, 0.46)";
  ctx.lineWidth = 3;
  ctx.strokeRect(field.left, field.top, field.right - field.left, field.bottom - field.top);

  ctx.beginPath();
  ctx.moveTo(WIDTH / 2, field.top);
  ctx.lineTo(WIDTH / 2, field.bottom);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(WIDTH / 2, HEIGHT / 2, 84, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "rgba(217,255,227,0.58)";
  ctx.beginPath();
  ctx.arc(WIDTH / 2, HEIGHT / 2, 4, 0, Math.PI * 2);
  ctx.fill();

  drawPenaltyArea(field.left, 1);
  drawPenaltyArea(field.right, -1);
  drawCornerMarks();
}

function drawPenaltyArea(x, direction) {
  ctx.strokeStyle = "rgba(217, 255, 227, 0.38)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, HEIGHT / 2, 137, -Math.PI / 2, Math.PI / 2, direction < 0);
  ctx.stroke();

  ctx.fillStyle = "rgba(217,255,227,0.48)";
  ctx.beginPath();
  ctx.arc(x + direction * 92, HEIGHT / 2, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawCornerMarks() {
  ctx.strokeStyle = "rgba(217, 255, 227, 0.26)";
  ctx.lineWidth = 2;
  const corners = [
    [field.left, field.top, 0, Math.PI / 2],
    [field.right, field.top, Math.PI / 2, Math.PI],
    [field.left, field.bottom, -Math.PI / 2, 0],
    [field.right, field.bottom, Math.PI, Math.PI * 1.5],
  ];
  corners.forEach(([x, y, start, end]) => {
    ctx.beginPath();
    ctx.arc(x, y, 26, start, end);
    ctx.stroke();
  });
}

function drawGoals() {
  drawGoal(field.left, -1, teams.red.color, goalMoment?.side === "left");
  drawGoal(field.right, 1, teams.blue.color, goalMoment?.side === "right");
}

function drawGoal(x, direction, glowColor, active) {
  const back = x + goal.depth * direction;
  const elapsed = active ? (performance.now() - goalMoment.startedAt) / 1000 : 0;
  const pulse = active ? Math.max(0, 1 - elapsed / 1.65) : 0;
  const ripple = Math.sin(elapsed * 24) * 7 * pulse;
  ctx.save();
  ctx.strokeStyle = "rgba(230, 241, 242, 0.32)";
  ctx.lineWidth = 2;
  ctx.fillStyle = active ? `${glowColor}22` : "rgba(255,255,255,0.025)";
  ctx.fillRect(Math.min(x, back), goal.top, goal.depth, goal.bottom - goal.top);
  ctx.strokeRect(Math.min(x, back), goal.top, goal.depth, goal.bottom - goal.top);

  ctx.strokeStyle = active ? `${glowColor}70` : "rgba(220,230,232,0.09)";
  ctx.lineWidth = 1;
  for (let y = goal.top + 18; y < goal.bottom; y += 18) {
    ctx.beginPath();
    ctx.moveTo(Math.min(x, back), y);
    ctx.quadraticCurveTo(x + direction * goal.depth * 0.55, y + ripple, Math.max(x, back), y);
    ctx.stroke();
  }
  for (let offset = 12; offset < goal.depth; offset += 12) {
    ctx.beginPath();
    ctx.moveTo(x + offset * direction, goal.top);
    ctx.quadraticCurveTo(x + offset * direction + ripple * direction, HEIGHT / 2, x + offset * direction, goal.bottom);
    ctx.stroke();
  }

  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 11;
  ctx.fillStyle = "#e9f4f3";
  for (const y of [goal.top, goal.bottom]) {
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPlayer(player) {
  const team = teams[player.team];
  ctx.save();
  ctx.translate(player.x, player.y);

  ctx.fillStyle = "rgba(0,0,0,0.38)";
  ctx.beginPath();
  ctx.ellipse(3, 9, player.radius + 7, player.radius - 4, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowColor = team.color;
  ctx.shadowBlur = player.kickFlash > 0 ? 30 : 15;
  const gradient = ctx.createRadialGradient(-8, -10, 3, 0, 0, player.radius);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(0.14, team.color);
  gradient.addColorStop(1, team.dark);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, player.radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.rotate(Math.atan2(player.facingY, player.facingX));
  ctx.fillStyle = "#f6ffff";
  ctx.beginPath();
  ctx.arc(player.radius * 0.55, 0, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBallTrail() {
  ball.trail.forEach((point, index) => {
    const ratio = 1 - index / ball.trail.length;
    ctx.fillStyle = `rgba(217, 255, 67, ${ratio * 0.12 * point.life})`;
    ctx.beginPath();
    ctx.arc(point.x, point.y, ball.radius * ratio, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawBall() {
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

function drawParticles() {
  particles.forEach((particle) => {
    ctx.globalAlpha = Math.max(0, particle.life);
    ctx.fillStyle = particle.color;
    ctx.fillRect(particle.x, particle.y, particle.size, particle.size);
  });
  ctx.globalAlpha = 1;
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
  [220, 330, 440, 660].forEach((frequency, index) => {
    playTone(frequency, 0.2, "square", 0.025, index * 0.07);
  });
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  if (soundEnabled && !audioContext) {
    audioContext = new AudioContext();
  }
  soundButton.textContent = soundEnabled ? "SOUND ON" : "SOUND OFF";
  soundButton.classList.toggle("active", soundEnabled);
  soundButton.setAttribute("aria-label", soundEnabled ? "소리 끄기" : "소리 켜기");
  playTone(440, 0.06, "square", 0.025);
}

function loop(now) {
  const dt = Math.min((now - lastTime) / 1000, 1 / 30);
  lastTime = now;
  update(dt, now);
  draw();
  requestAnimationFrame(loop);
}

window.addEventListener("keydown", (event) => {
  if (["Space", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
    event.preventDefault();
  }
  keys.add(event.code);
  if (event.code === "KeyR" && gameState !== "menu") startMatch();
});

window.addEventListener("keyup", (event) => keys.delete(event.code));
window.addEventListener("blur", () => keys.clear());
startButton.addEventListener("click", startMatch);
soundButton.addEventListener("click", toggleSound);

updateHud();
requestAnimationFrame(loop);
