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

  // --- Safety: force-hide color picker on load/lobby ---
  function forceHideColorPicker() {
    if (colorPicker) colorPicker.classList.add('hidden');
    pendingWildCardId = null;
  }
  forceHideColorPicker();
  const lobbyObs = new MutationObserver(() => {
    if (!joinSection.classList.contains('hidden')) forceHideColorPicker();
  });
  lobbyObs.observe(document.body, { attributes: true, childList: true, subtree: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') forceHideColorPicker(); });
  colorPicker.addEventListener('click', (e) => { if (e.target === colorPicker) forceHideColorPicker(); });

  // Buttons under meta
  let extraBar = document.getElementById('extraBar');
  if (!extraBar) {
    extraBar = document.createElement('div');
    extraBar.id = 'extraBar';
    extraBar.style.display = 'flex';
    extraBar.style.gap = '8px';
    extraBar.style.marginTop = '6px';
    const meta = document.querySelector('.meta .actions');
    meta && meta.after(extraBar);
  }
  const unoBtn = document.createElement('button'); unoBtn.textContent = 'UNO!';
  const calloutBtn = document.createElement('button'); calloutBtn.textContent = 'Callout';
  const challengeBtn = document.createElement('button'); challengeBtn.textContent = 'Challenge +4';
  const nextRoundBtn = document.createElement('button'); nextRoundBtn.textContent = 'Next Round'; nextRoundBtn.classList.add('ghost');
  extraBar.append(unoBtn, calloutBtn, challengeBtn, nextRoundBtn);

  let ws = null;
  let state = null;
  let pendingWildCardId = null;

  function randomRoom() {
    const syll = ['ra','ka','shi','ka','ai','ka','to','fu','mi','na','yo','ri','za','go'];
    let s = '';
    for (let i=0;i<3;i++) s += syll[Math.floor(Math.random()*syll.length)];
    return s + Math.floor(Math.random()*100);
  }

  if (!roomInput.value) roomInput.value = (localStorage.getItem('uno_room') || randomRoom());
  if (!nameInput.value) nameInput.value = (localStorage.getItem('uno_name') || 'Player');

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}`;
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      statusEl.textContent = 'Connected';
      // do not auto-join; wait for button
    });
    ws.addEventListener('close', () => {
      statusEl.textContent = 'Disconnected';
    });
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        state = msg.data;
        render();
      } else if (msg.type === 'error') {
        alert(msg.message || 'Error');
      }
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
  }

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
    unoBtn.disabled = !(state.mustPressUno);
    calloutBtn.disabled = !(state.canCallout);
    challengeBtn.disabled = !(state.canChallenge);
    nextRoundBtn.disabled = !(state.winner && !state.matchWinner);

    if (state.matchWinner) statusEl.textContent = `🏆 Match: ${state.players.find(p=>p.id===state.matchWinner)?.name || 'Player'} won`;
    else if (state.winner) statusEl.textContent = `🎉 Round: ${state.players.find(p=>p.id===state.winner)?.name || 'Player'} won`;
    else statusEl.textContent = state.yourTurn ? 'Your turn' : 'Their turn';
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
      openColorPicker();
    } else {
      ws.send(JSON.stringify({ type: 'play', cardId: card.id }));
    }
  }

  function openColorPicker() { colorPicker.classList.remove('hidden'); }
  function closeColorPicker() { colorPicker.classList.add('hidden'); }
  colorButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const chosen = btn.getAttribute('data-color');
      if (pendingWildCardId) {
        ws.send(JSON.stringify({ type: 'play', cardId: pendingWildCardId, chosenColor: chosen }));
        pendingWildCardId = null;
      }
      closeColorPicker();
    });
  });

  drawBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'draw' })));
  resetBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'reset' })));
  unoBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'uno' })));
  calloutBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'callout' })));
  challengeBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'challenge' })));
  nextRoundBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'next-round' })));

  joinBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) connect();
    setTimeout(join, 100); // slight delay to ensure socket open
  });

  // Autoconnect
  connect();
})();