(() => {
  const joinSection = document.getElementById('joinSection');
  const gameSection = document.getElementById('gameSection');
  const statusEl = document.getElementById('status');
  const lastActionEl = document.getElementById('lastAction');
  const handEl = document.getElementById('hand');
  const topCardEl = document.getElementById('topCard');
  const currentColorEl = document.getElementById('currentColor');
  const playersEl = document.getElementById('players');
  const drawBtn = document.getElementById('drawBtn');
  const resetBtn = document.getElementById('resetBtn');
  const roomInput = document.getElementById('room');
  const nameInput = document.getElementById('name');
  const joinBtn = document.getElementById('joinBtn');

  const colorPicker = document.getElementById('colorPicker');
  const colorButtons = colorPicker.querySelectorAll('.color-btn');

  // Strong force-hide on load
  colorPicker.classList.add('hidden');
  colorPicker.style.display = 'none';

  let ws = null;
  let state = null;
  let pendingWildCardId = null;

  function connect(cb) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}`;
    ws = new WebSocket(url);
    ws.addEventListener('open', () => { statusEl.textContent = 'Connected'; cb && cb(); });
    ws.addEventListener('close', () => { statusEl.textContent = 'Disconnected'; });
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') { state = msg.data; render(); }
      else if (msg.type === 'error') { alert(msg.message || 'Error'); }
    });
  }

  function join() {
    const room = roomInput.value.trim();
    const name = nameInput.value.trim() || 'Player';
    if (!room) return alert('Enter a room code');
    localStorage.setItem('uno_room', room);
    localStorage.setItem('uno_name', name);
    ws.send(JSON.stringify({ type: 'join', roomId: room, name }));
    joinSection.classList.add('hidden');
    gameSection.classList.remove('hidden');
    // Always hide color dialog on lobby -> game transition
    colorPicker.classList.add('hidden');
    colorPicker.style.display = 'none';
  }

  joinBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) connect(join);
    else join();
  });

  function render() {
    if (!state) return;
    lastActionEl.textContent = state.lastAction || '';
    currentColorEl.textContent = state.currentColor || '—';

    playersEl.innerHTML = '';
    state.players.forEach(p => {
      const pill = document.createElement('div');
      pill.className = 'player-pill' + (state.you && p.id === state.you.id ? ' you' : '');
      const turnDot = (state.turn === p.id && !state.winner && !state.matchWinner) ? ' •' : '';
      pill.textContent = `${p.name}: ${p.handCount} | ${p.score || 0}/${state.targetScore || 200}${turnDot}`;
      playersEl.appendChild(pill);
    });

    topCardEl.innerHTML = '';
    if (state.topCard) topCardEl.appendChild(renderCard(state.topCard, false));
    else topCardEl.textContent = '—';

    handEl.innerHTML = '';
    const yourTurn = state.yourTurn && !state.winner && !state.matchWinner;
    const playableIds = new Set((state.yourHand || []).filter(c => cardPlayable(c)).map(c => c.id));
    state.yourHand.forEach(card => {
      const btn = renderCard(card, true);
      const canPlay = yourTurn && playableIds.has(card.id);
      if (canPlay) { btn.classList.add('playable'); btn.addEventListener('click', () => onPlay(card)); }
      else { btn.disabled = true; }
      handEl.appendChild(btn);
    });

    drawBtn.disabled = !(yourTurn && !state.winner && !state.matchWinner && playableIds.size === 0);
    resetBtn.disabled = false;
  }

  function renderCard(card, asButton) {
    const el = document.createElement(asButton ? 'button' : 'div');
    el.className = 'card-btn';
    if (card.color === 'W') el.classList.add('wild');
    const colorText = card.color === 'R' ? 'Red' :
                      card.color === 'Y' ? 'Yellow' :
                      card.color === 'G' ? 'Green' :
                      card.color === 'B' ? 'Blue' :
                      'Wild';
    el.innerHTML = `<div class="v">${card.value}</div><div class="c">${colorText}</div>`;
    return el;
  }

  function cardPlayable(card) {
    if (state.pendingDraw > 0 && state.stackingType) return card.value === state.stackingType;
    if (card.color === 'W') return true;
    if (!state.topCard) return true;
    return card.value === state.topCard.value || card.color === state.currentColor;
  }

  function onPlay(card) {
    if (card.color === 'W') {
      pendingWildCardId = card.id;
      colorPicker.classList.remove('hidden');
      colorPicker.style.display = 'flex';
    } else {
      ws.send(JSON.stringify({ type: 'play', cardId: card.id }));
    }
  }

  colorButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const chosen = btn.getAttribute('data-color');
      if (pendingWildCardId) {
        ws.send(JSON.stringify({ type: 'play', cardId: pendingWildCardId, chosenColor: chosen }));
        pendingWildCardId = null;
      }
      colorPicker.classList.add('hidden');
      colorPicker.style.display = 'none';
    });
  });

  drawBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'draw' })));
  resetBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'reset' })));

  // Connect on load (won't auto-join)
  connect();
})();