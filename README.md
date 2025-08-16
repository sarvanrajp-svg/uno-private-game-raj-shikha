# Private 2‑Player UNO (Web)
A simple, private UNO‑style game you and a friend can play in a mobile browser. One small Node server hosts both the game and the realtime WebSocket sync.

> **Note:** This is a simplified UNO implementation: no stacking, no +4 challenge, and "Reverse" acts like "Skip" in 2‑player games.

## Quick Start (Glitch — easiest)
1. Go to https://glitch.com → **New Project** → **Hello‑Express**.
2. Delete all default files and upload the contents of this folder (drag + drop).
3. Wait for Glitch to install dependencies (you’ll see a console log).
4. Click **Show** → the game's URL opens. Share the URL with your partner.
5. One of you creates/joins a room with a short **Room Code** (e.g. `raj123`),
   the other joins the same code. Play!

## Local Run (desktop)
1. Install Node 18+
2. `npm install`
3. `npm start`
4. Open http://localhost:3000 on both phones while connected to the same network.

## Rules (simplified)
- Match by **color** or **value**, or play **Wild**/**+4** anytime.
- **+2** and **+4**: next player draws 2/4 *and is skipped*.
- **Skip**: next player is skipped.
- **Reverse**: acts like **Skip** in a 2‑player game.
- Draw 1 ends your turn (no "draw‑to‑match").
- No UNO call or penalty.
- First to 0 cards wins.

Enjoy!


## House Rules Added
- **Stacking**: Stack `+2` on `+2` and `+4` on `+4`. Pending draw accumulates and passes until a player can’t stack; then they draw the total and are skipped.
- **Must play if you can**: If you have a playable card, you can’t draw.
- **Draw-to-match**: If you truly can’t play, you will draw until you can; the first playable draw auto-plays.
- **UNO call + penalty**: When you drop to 1 card, tap **UNO!**. If you forget, your opponent can tap **Callout** before the next play; you draw **2**.
- **+4 Challenge**: If you get hit with `+4`, tap **Challenge +4** if you think it was illegal. If the player **did** have a card of the previous color, they draw 4; otherwise you draw +2 extra.
- **Scoring to 200**: End-of-round scoring adds the opponent’s remaining hand per classic UNO values (0–9 = face value, Skip/Reverse/+2 = 20, Wild/+4 = 50). First to 200 wins the match.

### Notes
- In 2-player games, **Reverse** behaves like **Skip**.
- Stacking only stacks **same type** (`+2` on `+2`, `+4` on `+4`).
