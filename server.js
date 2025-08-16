
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// In-memory room state (reset on server restart)
const rooms = new Map();

// --- Configurable options / house rules ---
const TARGET_SCORE = 200; // total to win match
const STACKING = true; // allow stacking draw cards
const MUST_PLAY_IF_CAN = true; // no drawing if you already have a playable
const DRAW_TO_MATCH = true; // keep drawing till you can play (auto plays first playable draw)
const PLUS4_CHALLENGE = true; // allow challenge mechanic
const UNO_PENALTY = 2; // draw 2 if failed to say UNO and opponent calls out

function makeDeck() {
  const colors = ['R', 'Y', 'G', 'B'];
  let deck = [];
  // number & action cards
  for (const c of colors) {
    deck.push(card(c, '0'));
    for (let i = 1; i <= 9; i++) deck.push(card(c, String(i)), card(c, String(i)));
    for (const v of ['Skip','Reverse','+2']) deck.push(card(c, v), card(c, v));
  }
  for (let i = 0; i < 4; i++) deck.push(card('W','Wild'), card('W','+4'));
  shuffle(deck);
  return deck;
}

function card(color, value) {
  return { id: uid(), color, value };
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function uid() { return Math.random().toString(36).slice(2,10); }

function makeRoom(roomId) {
  return {
    id: roomId,
    players: [], // [{id, name, score}]
    sockets: new Map(), // id -> ws
    hands: new Map(), // id -> [cards]
    deck: [],
    discard: [],
    currentColor: null,
    turn: null,
    started: false,
    winner: null, // playerId for round winner
    matchWinner: null, // playerId for match winner
    lastAction: 'Waiting for players…',
    // house-rule state
    pendingDraw: 0, // accumulated draw due to stacking
    stackingType: null, // '+2' or '+4' when stacking
    mustCallUno: new Set(), // players who now have 1 card and must press UNO before next turn changes
    unoCalled: new Set(), // players who have successfully called UNO for this turn
    challengeWindow: null, // {fromId, toId, playedCard, priorColor, priorHandSnapshot}
  };
}

function nextPlayerId(room, currentId, skipCount = 1) {
  const idx = room.players.findIndex(p => p.id === currentId);
  if (idx === -1) return null;
  const n = room.players.length;
  return room.players[(idx + skipCount) % n].id;
}

function deal(room) {
  room.deck = makeDeck();
  room.discard = [];
  // hands
  for (const p of room.players) {
    const hand = [];
    for (let i = 0; i < 7; i++) hand.push(room.deck.pop());
    room.hands.set(p.id, hand);
  }
  // flip first non +4 to start
  let starter;
  while (room.deck.length) {
    const c = room.deck.pop();
    if (c.value === '+4') room.deck.unshift(c);
    else { starter = c; break; }
  }
  if (!starter) starter = card('R','0');
  room.discard.push(starter);
  room.currentColor = starter.color === 'W' ? 'R' : starter.color;

  // reset per-round state
  room.pendingDraw = 0;
  room.stackingType = null;
  room.mustCallUno.clear();
  room.unoCalled.clear();
  room.challengeWindow = null;
}

function reshuffleIfNeeded(room) {
  if (room.deck.length === 0) {
    const top = room.discard.pop();
    room.deck = room.discard;
    room.discard = [top];
    shuffle(room.deck);
  }
}

function sanitize(room, forPlayerId) {
  const you = room.players.find(p => p.id === forPlayerId);
  const players = room.players.map(p => ({
    id: p.id,
    name: p.name,
    handCount: (room.hands.get(p.id) || []).length,
    score: p.score || 0
  }));
  const yourHand = room.hands.get(forPlayerId) || [];
  return {
    roomId: room.id,
    you,
    players,
    yourHand,
    topCard: room.discard[room.discard.length - 1] || null,
    currentColor: room.currentColor,
    yourTurn: room.turn === forPlayerId,
    started: room.started,
    winner: room.winner,
    matchWinner: room.matchWinner,
    lastAction: room.lastAction,
    pendingDraw: room.pendingDraw,
    stackingType: room.stackingType,
    mustPressUno: room.mustCallUno.has(forPlayerId) && !room.unoCalled.has(forPlayerId),
    canCallout: canCallout(room, forPlayerId),
    canChallenge: canChallenge(room, forPlayerId),
    targetScore: TARGET_SCORE
  };
}

function broadcast(room) {
  for (const p of room.players) {
    const ws = room.sockets.get(p.id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'state', data: sanitize(room, p.id) }));
    }
  }
}

function startGame(room) {
  room.started = true;
  room.winner = null;
  room.matchWinner = null;
  if (!room.players.some(p => p.score != null)) {
    room.players.forEach(p => p.score = 0);
  }
  deal(room);
  const first = room.players[Math.floor(Math.random() * room.players.length)];
  room.turn = first.id;
  room.lastAction = `Game started. ${first.name}'s turn.`;
  broadcast(room);
}

function canPlay(card, top, currentColor) {
  if (!top) return true;
  if (card.color === 'W') return true;
  return (card.color === currentColor) || (card.value === top.value);
}

function playableCards(room, playerId) {
  const hand = room.hands.get(playerId) || [];
  const top = room.discard[room.discard.length - 1] || null;
  const currentColor = room.currentColor;
  // If stacking is active, only allow stacking of same type
  if (room.pendingDraw > 0 && room.stackingType) {
    return hand.filter(c => c.value === room.stackingType);
  }
  return hand.filter(c => canPlay(c, top, currentColor));
}

function drawCards(room, playerId, n) {
  const hand = room.hands.get(playerId) || [];
  for (let i = 0; i < n; i++) {
    reshuffleIfNeeded(room);
    if (room.deck.length === 0) break;
    hand.push(room.deck.pop());
  }
  room.hands.set(playerId, hand);
}

function scoreHand(cards) {
  // Standard UNO scoring
  let s = 0;
  for (const c of cards) {
    if (/^\d+$/.test(c.value)) s += parseInt(c.value, 10);
    else if (c.value === 'Wild') s += 50;
    else if (c.value === '+4') s += 50;
    else s += 20; // Skip, Reverse, +2
  }
  return s;
}

function endRound(room, winnerId) {
  room.winner = winnerId;
  // sum opponent's hand
  const loserId = room.players.find(p => p.id !== winnerId)?.id;
  const loserHand = room.hands.get(loserId) || [];
  const points = scoreHand(loserHand);
  const winP = room.players.find(p => p.id === winnerId);
  winP.score += points;
  room.lastAction = `${getName(room, winnerId)} wins the round and gains ${points} points.`;

  // Check match end
  if (winP.score >= TARGET_SCORE) {
    room.matchWinner = winnerId;
    room.turn = null;
  }
  broadcast(room);
}

function getName(room, playerId) {
  const p = room.players.find(p => p.id === playerId);
  return p ? p.name : 'Player';
}

function colorName(c) {
  return { R:'Red', Y:'Yellow', G:'Green', B:'Blue' }[c] || c;
}

function describeCard(c) {
  const colorFull = { R:'Red', Y:'Yellow', G:'Green', B:'Blue', W:'Wild' }[c.color] || c.color;
  return c.color === 'W' ? c.value : `${colorFull} ${c.value}`;
}

function canCallout(room, callerId) {
  // You can call out if the opponent has 1 card and has not called UNO yet,
  // and it's still within the window (before they finish their next turn start).
  const oppId = room.players.find(p => p.id !== callerId)?.id;
  if (!oppId) return false;
  const oppHand = room.hands.get(oppId) || [];
  if (oppHand.length === 1 && room.mustCallUno.has(oppId) && !room.unoCalled.has(oppId)) {
    // Only allowed until turn passes back to offender (simplify: allow anytime before next card is played by anyone)
    return true;
  }
  return false;
}

function canChallenge(room, playerId) {
  // The player who received +4 may challenge right after it is played and before playing/stacking/drawing
  const cw = room.challengeWindow;
  if (!PLUS4_CHALLENGE || !cw) return false;
  return playerId === cw.toId && room.pendingDraw > 0 && room.stackingType === '+4';
}

function applyCardEffects(room, playerId, card, chosenColor, priorColor, priorHandSnapshot) {
  // Update color
  room.currentColor = (card.color === 'W') ? chosenColor : card.color;

  // Effects & turn logic
  let skipCount = 1;

  if (card.value === '+2') {
    if (STACKING) {
      room.pendingDraw += 2;
      room.stackingType = '+2';
      room.lastAction = `${getName(room, playerId)} stacked +2. Pending draw: ${room.pendingDraw}.`;
      // pass turn normally to allow next player to stack
      room.turn = nextPlayerId(room, playerId, 1);
      return;
    } else {
      const otherId = nextPlayerId(room, playerId, 1);
      drawCards(room, otherId, 2);
      skipCount = 2;
      room.lastAction = `${getName(room, playerId)} played +2. ${getName(room, otherId)} drew 2 and was skipped.`;
    }
  } else if (card.value === '+4') {
    if (STACKING) {
      room.pendingDraw += 4;
      room.stackingType = '+4';
      room.lastAction = `${getName(room, playerId)} played +4${chosenColor ? ' ('+colorName(room.currentColor)+')' : ''}. Pending draw: ${room.pendingDraw}.`;
      // open challenge window for the next player
      if (PLUS4_CHALLENGE) {
        room.challengeWindow = {
          fromId: playerId,
          toId: nextPlayerId(room, playerId, 1),
          playedCard: card,
          priorColor,
          priorHandSnapshot
        };
      }
      room.turn = nextPlayerId(room, playerId, 1);
      return;
    } else {
      const otherId = nextPlayerId(room, playerId, 1);
      drawCards(room, otherId, 4);
      skipCount = 2;
      room.lastAction = `${getName(room, playerId)} played +4 (${colorName(room.currentColor)}). ${getName(room, otherId)} drew 4 and was skipped.`;
    }
  } else if (card.value === 'Skip') {
    skipCount = 2;
    room.lastAction = `${getName(room, playerId)} played Skip.`;
  } else if (card.value === 'Reverse') {
    // acts like Skip in 2-player
    skipCount = 2;
    room.lastAction = `${getName(room, playerId)} played Reverse (skip).`;
  } else if (card.color === 'W' && card.value === 'Wild') {
    room.lastAction = `${getName(room, playerId)} played Wild. Color is now ${colorName(room.currentColor)}.`;
  } else {
    room.lastAction = `${getName(room, playerId)} played ${describeCard(card)}.`;
  }

  room.turn = nextPlayerId(room, playerId, skipCount);
}

function finishPlayAndCheckUno(room, playerId) {
  const hand = room.hands.get(playerId) || [];
  if (hand.length === 0) {
    endRound(room, playerId);
    return true;
  }
  // UNO tracking
  if (hand.length === 1) {
    room.mustCallUno.add(playerId);
    room.unoCalled.delete(playerId);
  } else {
    room.mustCallUno.delete(playerId);
    room.unoCalled.delete(playerId);
  }
  return false;
}

function performDrawToMatch(room, playerId) {
  // Draw until a playable card appears, then auto-play it (common house rule).
  while (true) {
    const playable = playableCards(room, playerId);
    if (playable.length > 0) break;
    // draw one
    drawCards(room, playerId, 1);
    // If the just-drawn is playable, auto-play it
    const newPlayable = playableCards(room, playerId);
    if (newPlayable.length > 0) {
      const c = newPlayable[0];
      // For wilds, choose the color with most in hand
      let chosen = null;
      if (c.color === 'W') {
        chosen = bestColor(room, playerId) || 'R';
      }
      // snapshot for +4 challenge check
      const topBefore = room.currentColor;
      const handSnapshot = room.hands.get(playerId).slice();
      internalPlay(room, playerId, c.id, chosen, topBefore, handSnapshot);
      return;
    }
    // Safety if deck is empty and no reshuffle possible is handled in drawCards
    if (room.deck.length === 0) break;
  }
  // If still no playable after exhausting deck reshuffle attempts, pass turn
  room.lastAction = `${getName(room, playerId)} drew to match but couldn't play.`;
  room.turn = nextPlayerId(room, playerId, 1);
}

function bestColor(room, playerId) {
  const hand = room.hands.get(playerId) || [];
  const counts = {R:0,Y:0,G:0,B:0};
  hand.forEach(c => { if (counts[c.color] != null) counts[c.color]++; });
  return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
}

function internalPlay(room, playerId, cardId, chosenColor, priorColor, priorHandSnapshot) {
  if (room.winner || room.matchWinner) return;
  if (room.turn !== playerId) return;

  const hand = room.hands.get(playerId) || [];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) return;

  const card = hand[idx];
  const top = room.discard[room.discard.length - 1] || null;

  // Stacking constraint
  if (room.pendingDraw > 0 && room.stackingType) {
    if (card.value !== room.stackingType) return; // only stacking same type
  } else {
    if (!canPlay(card, top, room.currentColor)) return;
  }

  // For wilds, must have chosenColor
  if (card.color === 'W' && !chosenColor) return;

  // +4 challenge window is cleared when other actions happen
  if (room.challengeWindow) room.challengeWindow = null;

  // play it
  hand.splice(idx, 1);
  room.hands.set(playerId, hand);
  room.discard.push(card);

  applyCardEffects(room, playerId, card, chosenColor, priorColor, priorHandSnapshot);

  // After effects, if we didn't early-return (stacking turn handoff), check win/UNO
  if (room.turn === playerId) return; // shouldn't happen normally
  if (finishPlayAndCheckUno(room, playerId)) {
    broadcast(room);
    return;
  }

  // If the next player is under pending draw and cannot stack, they must draw and are skipped
  const nextId = room.turn;
  if (room.pendingDraw > 0 && room.stackingType) {
    const nextPlayable = playableCards(room, nextId);
    if (nextPlayable.length === 0) {
      drawCards(room, nextId, room.pendingDraw);
      room.lastAction += ` ${getName(room, nextId)} drew ${room.pendingDraw} and was skipped.`;
      room.pendingDraw = 0;
      room.stackingType = null;
      room.turn = nextPlayerId(room, nextId, 1);
    }
  }

  broadcast(room);
}

function handleJoin(ws, roomId, name) {
  if (!roomId || !name) return;
  const rid = roomId.trim().slice(0, 24);
  if (!rooms.has(rid)) rooms.set(rid, makeRoom(rid));
  const room = rooms.get(rid);
  if (room.players.length >= 2 && !room.players.find(p => p.name === name)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room is full (2 players max).' }));
    return { room, playerId: null };
  }
  // reuse same name slot if present
  let player = room.players.find(p => p.name === name);
  if (!player) {
    player = { id: uid(), name, score: 0 };
    room.players.push(player);
    room.hands.set(player.id, []);
  }
  room.sockets.set(player.id, ws);
  if (!room.started && room.players.length === 2) {
    startGame(room);
  } else {
    const data = sanitize(room, player.id);
    ws.send(JSON.stringify({ type: 'state', data }));
  }
  return { room, playerId: player.id };
}

function resolvePlus4Challenge(room, challengerId) {
  const cw = room.challengeWindow;
  if (!cw) return;
  // Determine legality: when +4 was played, did fromId have a card of priorColor?
  const hadColor = cw.priorHandSnapshot.some(c => c.color === cw.priorColor);
  const fromId = cw.fromId;
  const toId = cw.toId;
  if (challengerId !== toId) return;

  if (hadColor) {
    // +4 was illegal; original player draws 4
    drawCards(room, fromId, 4);
    room.lastAction = `${getName(room, challengerId)} challenged successfully. ${getName(room, fromId)} draws 4.`;
    // pending draw now applies only from stacks beyond the first +4; reset to remaining pending beyond first 4
    room.pendingDraw = Math.max(0, room.pendingDraw - 4);
  } else {
    // challenge failed; challenger draws +2 extra (total pending +2)
    drawCards(room, toId, 2);
    room.lastAction = `${getName(room, challengerId)} challenge failed and draws +2.`;
  }
  // Close window; continue with stacking or force-draw if no stack available
  room.challengeWindow = null;
  broadcast(room);
}

wss.on('connection', (ws, req) => {
  let currentRoomId = null;
  let playerId = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'join') {
        const { roomId, name } = msg;
        const joinRes = handleJoin(ws, roomId, name);
        currentRoomId = joinRes.room?.id || null;
        playerId = joinRes.playerId;
        return;
      }

      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room) return;

      if (msg.type === 'play') {
        if (room.winner || room.matchWinner) return;
        if (!playerId || room.turn !== playerId) return;

        // Must-play-if-can rule: if you can play, you cannot draw (handled on client also)
        const handPlayable = playableCards(room, playerId);
        // For wilds, ensure chosenColor
        const chosen = msg.chosenColor || null;
        // snapshot for +4 legality
        const priorColor = room.currentColor;
        const handSnapshot = room.hands.get(playerId).slice();
        // Internal play enforces all validations
        internalPlay(room, playerId, msg.cardId, chosen, priorColor, handSnapshot);
      }

      if (msg.type === 'draw') {
        if (room.winner || room.matchWinner) return;
        if (room.turn !== playerId) return;

        // Must-play-if-can: block drawing if any playable
        if (MUST_PLAY_IF_CAN) {
          const can = playableCards(room, playerId);
          if (can.length > 0) {
            const wsP = room.sockets.get(playerId);
            wsP && wsP.send(JSON.stringify({ type: 'error', message: 'You must play a card if you can.' }));
            return;
          }
        }

        if (room.pendingDraw > 0 && room.stackingType) {
          // If under pending draw and cannot stack, you must take the cards (handled in internalPlay chain)
          // But if player presses draw directly, resolve: take pending and skip
          drawCards(room, playerId, room.pendingDraw);
          room.lastAction = `${getName(room, playerId)} drew ${room.pendingDraw} and was skipped.`;
          room.pendingDraw = 0;
          room.stackingType = null;
          room.turn = nextPlayerId(room, playerId, 1);
          broadcast(room);
          return;
        }

        if (DRAW_TO_MATCH) {
          performDrawToMatch(room, playerId);
          broadcast(room);
        } else {
          // draw single and pass
          drawCards(room, playerId, 1);
          room.lastAction = `${getName(room, playerId)} drew a card.`;
          room.turn = nextPlayerId(room, playerId, 1);
          broadcast(room);
        }
      }

      if (msg.type === 'uno') {
        // Player declares UNO when they have exactly one card
        const hand = room.hands.get(playerId) || [];
        if (hand.length === 1) {
          room.unoCalled.add(playerId);
          room.mustCallUno.delete(playerId);
          room.lastAction = `${getName(room, playerId)} called UNO!`;
          broadcast(room);
        }
      }

      if (msg.type === 'callout') {
        // Opponent calls out failure to say UNO
        if (canCallout(room, playerId)) {
          const oppId = room.players.find(p => p.id !== playerId)?.id;
          drawCards(room, oppId, UNO_PENALTY);
          room.mustCallUno.delete(oppId);
          room.unoCalled.delete(oppId);
          room.lastAction = `${getName(room, playerId)} called out! ${getName(room, oppId)} draws ${UNO_PENALTY}.`;
          broadcast(room);
        }
      }

      if (msg.type === 'challenge') {
        if (canChallenge(room, playerId)) {
          resolvePlus4Challenge(room, playerId);
        }
      }

      if (msg.type === 'next-round') {
        // start new round if previous ended
        if (room.winner) {
          room.winner = null;
          deal(room);
          // next round starts with the loser of last round
          const lastWinnerId = room.players.find(p => p.id === playerId)?.id; // player clicking
          // Choose a random start to keep it simple, or alternate
          const first = room.players[Math.floor(Math.random() * room.players.length)];
          room.turn = first.id;
          room.lastAction = `New round. ${getName(room, first.id)} starts.`;
          broadcast(room);
        }
      }

      if (msg.type === 'reset') {
        room.started = false;
        room.winner = null;
        room.matchWinner = null;
        room.players.forEach(p => p.score = 0);
        room.lastAction = 'Resetting…';
        if (room.players.length >= 2) startGame(room);
        else broadcast(room);
      }
    } catch (e) {
      console.error('Message error:', e);
    }
  });

  ws.on('close', () => {
    if (!currentRoomId || !playerId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.sockets.delete(playerId);
  });
});

server.listen(PORT, () => {
  console.log(`UNO server listening on ${PORT}`);
});
