const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));
app.get('/ping', (req, res) => res.send('ok')); // 서버 깨우기용

const START_MONEY = 50; // 단위: 만원
const EVENT_EVERY = 12; // 이 턴 수마다 2:2 대결 이벤트 발생
const AUTO_MS = 25000; // 선택을 안 하면 이 시간(ms) 뒤 자동 처리
const BOARD = [
  { name: '계절학기', type: 'corner', amount: -10 },
  { name: '경영관', type: 'land', price: 10, toll: 4 },
  { name: '성지관', type: 'land', price: 10, toll: 4 },
  { name: '송백관', type: 'land', price: 12, toll: 5 },
  { name: '장학금', type: 'corner', amount: 10 },
  { name: '겅복관', type: 'land', price: 15, toll: 6 },
  { name: '건원관', type: 'land', price: 15, toll: 6 },
  { name: '범농관', type: 'land', price: 18, toll: 7 },
  { name: '자격증 응시', type: 'corner', amount: -20 },
  { name: '골프교육장', type: 'land', price: 20, toll: 8 },
  { name: '산학협력관', type: 'land', price: 22, toll: 9 },
  { name: '웅재관', type: 'land', price: 25, toll: 10 },
  { name: '입학축하금', type: 'corner', amount: 20, once: true },
  { name: '도서관', type: 'land', price: 28, toll: 12 },
  { name: '생명관', type: 'land', price: 30, toll: 12 },
  { name: '체육관', type: 'land', price: 35, toll: 15 },
];

const rooms = {}; // 방 코드 -> 방

function rollD6() {
  return Math.floor(Math.random() * 6) + 1;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 헷갈리는 글자(0, O, 1, I)를 뺀 4글자 방 코드
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function createRoom(isPublic) {
  const code = makeCode();
  const room = {
    id: code, isPublic,
    players: [], owners: {}, turn: 0,
    phase: 'waiting', log: [], started: false, ended: false, ranking: [],
    dice: null, seq: 0,
    turnCount: 0, queue: [], duel: null, duelSeq: 0,
    pending: null, notice: null, noticeSeq: 0, timer: null, cleanup: null,
  };
  rooms[code] = room;
  return room;
}

function findPublicRoom() {
  return Object.values(rooms).find((r) => r.isPublic && !r.started && !r.ended && r.players.length < 4);
}

function addLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 30) room.log.shift();
}

function setNotice(room, text, kind) {
  room.noticeSeq += 1;
  room.notice = { seq: room.noticeSeq, text, kind };
}

function broadcast(room) {
  // 선택이 필요한 단계에서는 자동 처리 타이머를 새로 건다
  clearTimeout(room.timer);
  if (!room.ended && ['buy', 'toll', 'swap'].includes(room.phase)) {
    room.timer = setTimeout(() => autoResolve(room), AUTO_MS);
  }
  io.to(room.id).emit('state', {
    code: room.id,
    board: BOARD,
    players: room.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, money: p.money, pos: p.pos })),
    owners: room.owners,
    turn: room.turn,
    phase: room.phase,
    log: room.log,
    ended: room.ended,
    ranking: room.ranking,
    dice: room.dice,
    duel: room.duel,
    pending: room.pending,
    notice: room.notice,
    eventLeft: EVENT_EVERY - (room.turnCount % EVENT_EVERY),
  });
}

function autoResolve(room) {
  if (room.ended) return;
  if (room.phase === 'buy') doSkip(room);
  else if (room.phase === 'toll') doPay(room);
  else if (room.phase === 'swap') doSwap(room, false);
  broadcast(room);
}

function checkEnd(room) {
  if (!room.players.some((p) => p.money < 0)) return false;
  room.ended = true;
  room.phase = 'ended';
  room.ranking = [...room.players].sort((a, b) => b.money - a.money).map((p) => p.name);
  addLog(room, '파산! 게임 종료');
  return true;
}

function advanceTurn(room) {
  room.turn = (room.turn + 1) % room.players.length;
  room.phase = 'roll';
}

// 대결 대기열에서 다음 대결을 시작 (없으면 다음 사람 차례로)
function nextDuel(room) {
  const q = room.queue.shift();
  if (!q) return advanceTurn(room);
  const a = room.players.find((p) => p.id === q[0]);
  const b = room.players.find((p) => p.id === q[1]);
  if (!a || !b) return nextDuel(room);
  let ra, rb;
  do {
    ra = rollD6();
    rb = rollD6();
  } while (ra === rb);
  const winner = ra > rb ? a : b;
  room.duelSeq += 1;
  room.duel = { a: a.id, b: b.id, ra, rb, winner: winner.id, reason: q[2], seq: room.duelSeq };
  room.phase = 'swap';
  addLog(room, `⚔️ ${q[2]}! ${a.name}(${ra}) vs ${b.name}(${rb}) → ${winner.name} 승리`);
}

function endTurn(room) {
  if (checkEnd(room)) return;
  const cur = room.players[room.turn];
  room.turnCount += 1;
  const queue = [];

  // 같은 칸에 다른 사람이 있으면 대결
  const mates = room.players.filter((p) => p.id !== cur.id && p.pos === cur.pos);
  if (mates.length > 0) {
    const other = mates[Math.floor(Math.random() * mates.length)];
    queue.push([cur.id, other.id, '같은 칸 만남']);
  }

  // 일정 턴마다 4명을 2명씩 짝지어 대결
  if (room.turnCount % EVENT_EVERY === 0 && room.players.length === 4) {
    const ids = shuffle(room.players.map((p) => p.id));
    queue.push([ids[0], ids[1], '정기 이벤트']);
    queue.push([ids[2], ids[3], '정기 이벤트']);
  }

  room.queue = queue;
  if (queue.length > 0) return nextDuel(room);
  advanceTurn(room);
}

// 칸에 도착했을 때 처리
function land(room, player) {
  const cell = BOARD[player.pos];
  if (cell.type === 'corner') {
    if (cell.once && player.gotWelcome) {
      addLog(room, `${player.name}: ${cell.name} (이미 받음)`);
    } else {
      if (cell.once) player.gotWelcome = true;
      player.money += cell.amount;
      const sign = cell.amount > 0 ? '+' : '';
      addLog(room, `${player.name}: ${cell.name} ${sign}${cell.amount}만`);
      setNotice(room, `${player.name} · ${cell.name}! ${sign}${cell.amount}만원`, cell.amount > 0 ? 'good' : 'bad');
    }
    return endTurn(room);
  }
  const ownerId = room.owners[player.pos];
  if (!ownerId) {
    if (player.money >= cell.price) {
      room.phase = 'buy'; // 구매 카드 대기
      return;
    }
    addLog(room, `${player.name}: ${cell.name} 돈이 부족해 구매 불가`);
    return endTurn(room);
  }
  if (ownerId === player.id) {
    addLog(room, `${player.name}: 내 땅 ${cell.name} 도착`);
    return endTurn(room);
  }
  const owner = room.players.find((p) => p.id === ownerId);
  room.pending = { ownerId, amount: cell.toll, cell: player.pos };
  room.phase = 'toll'; // 통행료 경고 카드 대기
  addLog(room, `⚠️ ${player.name}: ${owner.name}의 ${cell.name} 도착! 통행료 ${cell.toll}만`);
}

function doBuy(room) {
  const player = room.players[room.turn];
  const cell = BOARD[player.pos];
  player.money -= cell.price;
  room.owners[player.pos] = player.id;
  addLog(room, `${player.name}: ${cell.name} 구매 (-${cell.price}만)`);
  setNotice(room, `🏫 ${player.name}님이 ${cell.name} 구매! (-${cell.price}만)`, 'buy');
  endTurn(room);
}

function doSkip(room) {
  addLog(room, `${room.players[room.turn].name}: 구매 안 함`);
  endTurn(room);
}

function doPay(room) {
  const pend = room.pending;
  const player = room.players[room.turn];
  const owner = room.players.find((p) => p.id === pend.ownerId);
  player.money -= pend.amount;
  owner.money += pend.amount;
  addLog(room, `${player.name} → ${owner.name}에게 통행료 ${pend.amount}만`);
  setNotice(room, `💸 ${player.name} → ${owner.name} 통행료 ${pend.amount}만`, 'toll');
  room.pending = null;
  endTurn(room);
}

function doSwap(room, flag) {
  const d = room.duel;
  const a = room.players.find((p) => p.id === d.a);
  const b = room.players.find((p) => p.id === d.b);
  const winner = room.players.find((p) => p.id === d.winner);
  if (flag && a && b) {
    const tmp = a.pos;
    a.pos = b.pos;
    b.pos = tmp;
    addLog(room, `🔄 ${winner.name}: 자리 교환! (${a.name} ↔ ${b.name})`);
    setNotice(room, `🔄 ${a.name} ↔ ${b.name} 자리 교환!`, 'buy');
  } else {
    addLog(room, `${winner.name}: 자리 그대로 유지`);
  }
  nextDuel(room);
}

// 숫자 범위 안전하게 맞추기
function clamp(v, max) {
  v = parseInt(v, 10);
  return Number.isInteger(v) && v >= 0 && v <= max ? v : 0;
}

// 방에 플레이어 입장시키기 (방 만들기 / 코드 참여 / 빠른 입장 공통)
function enter(socket, room, data) {
  const a = data.avatar || {};
  socket.join(room.id);
  const name = String(data.name || '').trim().slice(0, 6) || '학생' + (room.players.length + 1);
  room.players.push({
    id: socket.id,
    name,
    avatar: {
      hair: clamp(a.hair, 5),
      style: clamp(a.style, 3),
      skin: clamp(a.skin, 3),
      top: clamp(a.top, 3),
      topColor: clamp(a.topColor, 5),
      bottom: clamp(a.bottom, 3),
      hat: !!a.hat,
      glasses: !!a.glasses,
    },
    money: START_MONEY, pos: 0, gotWelcome: false,
  });
  addLog(room, `${name} 입장 (${room.players.length}/4)`);
  if (room.players.length === 4) {
    room.started = true;
    room.phase = 'roll';
    addLog(room, '게임 시작!');
  }
  socket.emit('joined', { id: socket.id, code: room.id });
  broadcast(room);
}

io.on('connection', (socket) => {
  let room = null;

  // 🏠 방 만들기 (코드를 아는 사람만 입장)
  socket.on('create', (data) => {
    if (room) return;
    room = createRoom(false);
    enter(socket, room, data || {});
  });

  // 코드로 참여
  socket.on('join', (data) => {
    if (room) return;
    data = data || {};
    const code = String(data.code || '').trim().toUpperCase();
    const target = rooms[code];
    if (!target) return socket.emit('joinError', '방을 찾을 수 없어요. 코드를 다시 확인해 주세요.');
    if (target.started || target.ended) return socket.emit('joinError', '이미 게임이 시작된 방이에요.');
    if (target.players.length >= 4) return socket.emit('joinError', '방이 가득 찼어요.');
    room = target;
    enter(socket, room, data);
  });

  // ⚡ 빠른 입장 (공개 방에 자동으로 들어가기)
  socket.on('quick', (data) => {
    if (room) return;
    room = findPublicRoom() || createRoom(true);
    enter(socket, room, data || {});
  });

  const myTurn = (phase) =>
    room && room.started && !room.ended &&
    room.players[room.turn].id === socket.id && room.phase === phase;

  socket.on('roll', () => {
    if (!myTurn('roll')) return;
    const player = room.players[room.turn];
    const dice = rollD6();
    room.seq += 1;
    room.dice = { n: dice, seq: room.seq };
    player.pos = (player.pos + dice) % BOARD.length;
    addLog(room, `${player.name}: 주사위 ${dice} → ${BOARD[player.pos].name}`);
    land(room, player);
    broadcast(room);
  });

  socket.on('buy', () => {
    if (!myTurn('buy')) return;
    doBuy(room);
    broadcast(room);
  });

  socket.on('skip', () => {
    if (!myTurn('buy')) return;
    doSkip(room);
    broadcast(room);
  });

  // 통행료 경고 카드에서 "통행료 내기"
  socket.on('pay', () => {
    if (!myTurn('toll')) return;
    doPay(room);
    broadcast(room);
  });

  // 대결 승자가 "자리 바꾸기 / 그대로"를 고르는 요청
  socket.on('swap', (flag) => {
    if (!room || room.ended || room.phase !== 'swap' || !room.duel) return;
    if (room.duel.winner !== socket.id) return;
    doSwap(room, flag === true);
    broadcast(room);
  });

  socket.on('disconnect', () => {
    if (!room) return;
    if (!room.ended) {
      if (!room.started) {
        room.players = room.players.filter((p) => p.id !== socket.id);
      } else {
        room.ended = true;
        room.phase = 'ended';
        room.ranking = [...room.players].sort((a, b) => b.money - a.money).map((p) => p.name);
        addLog(room, '플레이어가 나가서 게임 종료');
      }
      broadcast(room);
    }
    // 빈 방은 바로 지우고, 끝난 방은 10분 뒤에 지움
    if (room.players.length === 0) {
      clearTimeout(room.timer);
      clearTimeout(room.cleanup);
      delete rooms[room.id];
    } else if (room.ended && !room.cleanup) {
      const r = room;
      r.cleanup = setTimeout(() => {
        clearTimeout(r.timer);
        delete rooms[r.id];
      }, 10 * 60 * 1000);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));