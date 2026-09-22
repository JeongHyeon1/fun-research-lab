import assert from "node:assert/strict";

const apiBase = process.env.FUTSAL_API_BASE || "http://127.0.0.1:8787";
const websocketBase = apiBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const room = await createRoom({ roomName: "SMOKE TEST", teamSize: 1, durationMinutes: 1 });

const blue = await connectPlayer(room, "BLUE-TEST");
const red = await connectPlayer(room, "RED-TEST");
const started = await waitFor(
  red.socket,
  (message) => message.type === "state" && ["countdown", "playing"].includes(message.state.status),
);

assert.equal(started.state.players.length, 2);
assert.equal(started.state.players.filter((player) => player.team === "blue").length, 1);
assert.equal(started.state.players.filter((player) => player.team === "red").length, 1);

blue.socket.send(
  JSON.stringify({
    type: "input",
    input: { up: false, down: false, left: false, right: true, kick: false, sequence: 1 },
  }),
);

const chatPromise = waitFor(red.socket, (message) => message.type === "chat");
blue.socket.send(JSON.stringify({ type: "chat", text: "테스트 메시지" }));
const chatMessage = await chatPromise;
assert.equal(chatMessage.chat.text, "테스트 메시지");
assert.equal(chatMessage.chat.name, "BLUE-TEST");

const listedResponse = await fetch(`${apiBase}/api/rooms`);
const listed = await listedResponse.json();
const listedRoom = listed.rooms.find((entry) => entry.id === room.id);
assert.ok(listedRoom);
assert.equal(listedRoom.occupancy, 2);

blue.socket.close(1000, "smoke complete");
red.socket.close(1000, "smoke complete");

const largeRoom = await createRoom({ roomName: "4V4 TEST", teamSize: 4, durationMinutes: 10 });
const clients = [];
for (let index = 0; index < 8; index += 1) {
  clients.push(await connectPlayer(largeRoom, `PLAYER-${index + 1}`));
}
const fullState = await waitFor(
  clients.at(-1).socket,
  (message) => message.type === "state" && ["countdown", "playing"].includes(message.state.status),
);
assert.equal(fullState.state.players.length, 8);
assert.equal(fullState.state.players.filter((player) => player.team === "blue").length, 4);
assert.equal(fullState.state.players.filter((player) => player.team === "red").length, 4);
clients.forEach(({ socket }) => socket.close(1000, "smoke complete"));

console.log(`online smoke passed: 1v1=${room.id}, 4v4=${largeRoom.id}`);

async function createRoom(payload) {
  const response = await fetch(`${apiBase}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 201);
  const data = await response.json();
  return data.room;
}

async function connectPlayer(targetRoom, name) {
  const socket = new WebSocket(
    `${websocketBase}/api/rooms/${targetRoom.id}/socket?name=${encodeURIComponent(name)}`,
  );
  const welcome = await waitFor(socket, (message) => message.type === "welcome");
  assert.ok(welcome.playerId);
  assert.ok(welcome.token);
  return { socket, welcome };
}

function waitFor(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket connection failed"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}
