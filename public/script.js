const socket = io();

const roomInput = document.getElementById("roomInput");
const nameInput = document.getElementById("nameInput");
const joinBtn = document.getElementById("joinBtn");
const gameArea = document.getElementById("gameArea");
const roomDisplay = document.getElementById("roomDisplay");
const playerNameDisplay = document.getElementById("playerNameDisplay");

joinBtn.addEventListener("click", () => {
  const room = roomInput.value.trim();
  const name = nameInput.value.trim();

  if (!room || !name) {
    alert("Please enter both Room Code and Your Name");
    return;
  }

  socket.emit("joinRoom", { room, name });
});

socket.on("roomJoined", ({ room, name }) => {
  document.querySelector(".form").style.display = "none";
  gameArea.style.display = "block";
  roomDisplay.innerText = `Room: ${room}`;
  playerNameDisplay.innerText = `Player: ${name}`;
});
