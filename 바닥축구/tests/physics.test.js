import assert from "node:assert/strict";
import test from "node:test";
import {
  WORLD,
  addMatchPlayer,
  createMatch,
  serializeMatch,
  setPlayerInput,
  stepMatch,
} from "../shared/physics.js";

function createPlayingMatch(config = {}) {
  const state = createMatch({ teamSize: 1, durationMinutes: 2, ...config });
  addMatchPlayer(state, { id: "blue", name: "BLUE" });
  addMatchPlayer(state, { id: "red", name: "RED" });
  state.status = "playing";
  return state;
}

function stepFor(state, seconds, dt = 1 / 60) {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) stepMatch(state, dt);
}

test("match settings are restricted to supported ranges", () => {
  assert.equal(createMatch({ teamSize: 0, durationMinutes: 0 }).teamSize, 1);
  assert.equal(createMatch({ teamSize: 9, durationMinutes: 20 }).teamSize, 4);
  assert.equal(createMatch({ teamSize: 9, durationMinutes: 20 }).durationMinutes, 10);
});

test("player badge accepts one Korean character or two Latin characters", () => {
  const state = createMatch({ teamSize: 2, durationMinutes: 2 });
  assert.equal(addMatchPlayer(state, { id: "one", name: "ONE", number: "한" }).number, "한");
  assert.equal(addMatchPlayer(state, { id: "two", name: "TWO", number: "ab" }).number, "AB");
  assert.equal(addMatchPlayer(state, { id: "three", name: "THREE", number: "너무김" }).number, "10");
});

test("passive contact pushes the ball without a large bounce", () => {
  const state = createPlayingMatch();
  const player = state.players[0];
  player.x = 500;
  player.y = 360;
  player.facingX = 1;
  player.facingY = 0;
  state.ball.x = player.x + player.radius + state.ball.radius + 1;
  state.ball.y = player.y;

  setPlayerInput(state, player.id, {
    right: true,
    left: false,
    up: false,
    down: false,
    kick: false,
    sequence: 1,
  });
  stepFor(state, 0.8);

  const distance = Math.hypot(state.ball.x - player.x, state.ball.y - player.y);
  const speed = Math.hypot(state.ball.vx, state.ball.vy);
  assert.ok(distance < player.radius + state.ball.radius + 12, `ball distance was ${distance}`);
  assert.ok(speed < 400, `passive ball speed was ${speed}`);
  assert.ok(state.ball.x > 540);
});

test("the ball remains independent instead of magnetizing to the player", () => {
  const state = createPlayingMatch();
  const player = state.players[0];
  player.x = 500;
  player.y = 360;
  player.vx = 0;
  player.vy = 0;
  player.facingX = 1;
  player.facingY = 0;
  state.ball.x = 536;
  state.ball.y = 368;
  state.ball.vx = 0;
  state.ball.vy = 120;

  stepMatch(state, 1 / 60);

  assert.ok(state.ball.vy > 90, `lateral ball velocity was ${state.ball.vy}`);
  assert.ok(state.ball.y > 368, "ball should continue on its own trajectory");
});

test("kick input is meaningfully stronger than passive dribbling", () => {
  const state = createPlayingMatch();
  const player = state.players[0];
  player.x = 500;
  player.y = 360;
  player.facingX = 1;
  player.facingY = 0;
  state.ball.x = 536;
  state.ball.y = 360;

  setPlayerInput(state, player.id, {
    right: false,
    left: false,
    up: false,
    down: false,
    kick: true,
    sequence: 1,
  });
  stepMatch(state, 1 / 60);
  assert.ok(Math.hypot(state.ball.vx, state.ball.vy) > 450);
});

test("ball and player do not overlap when pinned into a corner", () => {
  const state = createPlayingMatch();
  const player = state.players[0];
  state.ball.x = WORLD.field.left + state.ball.radius;
  state.ball.y = WORLD.field.top + state.ball.radius;
  player.x = state.ball.x;
  player.y = state.ball.y;
  player.vx = -200;
  player.vy = -200;

  stepFor(state, 0.25);

  const distance = Math.hypot(state.ball.x - player.x, state.ball.y - player.y);
  assert.ok(distance >= state.ball.radius + player.radius - 0.1, `overlap distance was ${distance}`);
  assert.ok(state.ball.x >= WORLD.field.left + state.ball.radius);
  assert.ok(state.ball.y >= WORLD.field.top + state.ball.radius);
});

test("a tied match enters golden goal and the next goal wins", () => {
  const state = createPlayingMatch();
  state.remainingSeconds = 0.01;
  stepMatch(state, 0.02);
  assert.equal(state.status, "goldenGoal");
  assert.equal(state.goldenGoal, true);

  state.ball.x = WORLD.field.right + state.ball.radius;
  state.ball.y = WORLD.height / 2;
  state.ball.vx = 300;
  stepMatch(state, 1 / 60);
  assert.equal(state.status, "goal");
  assert.equal(state.scores.blue, 1);

  stepFor(state, 2);
  assert.equal(state.status, "ended");
  assert.equal(state.winner, "blue");
  assert.equal(state.winReason, "golden-goal");
});

test("a team leading at full time wins without golden goal", () => {
  const state = createPlayingMatch();
  state.scores.blue = 2;
  state.scores.red = 1;
  state.remainingSeconds = 0.01;
  stepMatch(state, 0.02);
  assert.equal(state.status, "ended");
  assert.equal(state.winner, "blue");
  assert.equal(state.winReason, "regulation");
});

test("a normal goal exposes net animation state and uses a quiet restart countdown", () => {
  const state = createPlayingMatch();
  state.ball.x = WORLD.field.right + state.ball.radius;
  state.ball.y = WORLD.height / 2;
  stepMatch(state, 1 / 60);
  const goalSnapshot = serializeMatch(state);
  assert.equal(goalSnapshot.status, "goal");
  assert.equal(goalSnapshot.lastGoalSide, "right");

  stepFor(state, 1.67);
  assert.equal(state.status, "countdown");
  assert.equal(state.countdownReason, "restart");
});
