import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { createDeck, canPlay, applyCardEffect, shuffle } from './gameLogic.js';
import { randomUUID } from 'crypto';

const app = express();
app.use(cors({
  origin: ['https://rainbow-tartufo-1953ce.netlify.app', 'http://localhost:3000']
}));
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Game state
let gameState = {
  players: [],
  deck: [],
  discardPile: [],
  currentPlayerIndex: 0,
  direction: 1,
  gameStarted: false,
  winner: null,
  lastWildChosenColor: null,
  lobbyName: ''
};

const MAX_PLAYERS = 10;

function broadcastGameState() {
  const publicState = {
    players: gameState.players.map(p => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      ready: p.ready,
      isCurrentPlayer: p.id === gameState.players[gameState.currentPlayerIndex]?.id
    })),
    currentPlayerIndex: gameState.currentPlayerIndex,
    direction: gameState.direction,
    gameStarted: gameState.gameStarted,
    winner: gameState.winner,
    topCard: gameState.discardPile[gameState.discardPile.length - 1],
    lastWildChosenColor: gameState.lastWildChosenColor,
    lobbyName: gameState.lobbyName
  };
  io.emit('gameState', publicState);
}

function dealCards() {
  const deck = createDeck();
  gameState.deck = deck;
  gameState.discardPile = [];

  for (let player of gameState.players) {
    player.hand = [];
    for (let i = 0; i < 7; i++) {
      player.hand.push(gameState.deck.pop());
    }
  }

  let topCard = gameState.deck.pop();
  while (topCard.type === 'wild') {
    gameState.deck.unshift(topCard);
    topCard = gameState.deck.pop();
  }
  gameState.discardPile.push(topCard);

  gameState.currentPlayerIndex = 0;
  gameState.direction = 1;
}

function nextTurn(skipPlayer = false) {
  if (skipPlayer) {
    gameState.currentPlayerIndex = (gameState.currentPlayerIndex + gameState.direction + gameState.players.length) % gameState.players.length;
  }
  gameState.currentPlayerIndex = (gameState.currentPlayerIndex + gameState.direction + gameState.players.length) % gameState.players.length;

  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  if (currentPlayer && currentPlayer.hand.length === 0) {
    gameState.winner = currentPlayer;
    gameState.gameStarted = false;
  }

  broadcastGameState();
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('joinGame', ({ name, lobbyName, token }) => {
    // 1. Check for reconnection using token
    if (token) {
      const existingPlayer = gameState.players.find(p => p.token === token);
      if (existingPlayer) {
        // Reconnected player: update socket.id
        existingPlayer.id = socket.id;
        socket.join('game');

        // Send current public state and player's hand
        const publicState = {
          players: gameState.players.map(p => ({
            id: p.id,
            name: p.name,
            handCount: p.hand.length,
            ready: p.ready,
            isCurrentPlayer: p.id === gameState.players[gameState.currentPlayerIndex]?.id
          })),
          currentPlayerIndex: gameState.currentPlayerIndex,
          direction: gameState.direction,
          gameStarted: gameState.gameStarted,
          winner: gameState.winner,
          topCard: gameState.discardPile[gameState.discardPile.length - 1],
          lastWildChosenColor: gameState.lastWildChosenColor,
          lobbyName: gameState.lobbyName
        };
        socket.emit('gameState', publicState);
        socket.emit('yourHand', { hand: existingPlayer.hand });

        broadcastGameState(); // Notify others (optional)
        return;
      }
    }

    // 2. New player
    if (gameState.gameStarted) {
      socket.emit('error', { message: 'Game already in progress' });
      return;
    }
    if (gameState.players.length >= MAX_PLAYERS) {
      socket.emit('error', { message: `Game is full (max ${MAX_PLAYERS} players)` });
      return;
    }

    const newToken = randomUUID();
    const newPlayer = {
      id: socket.id,
      name: name || `Player ${gameState.players.length + 1}`,
      hand: [],
      ready: false,
      token: newToken
    };
    gameState.players.push(newPlayer);
    socket.join('game');

    if (gameState.players.length === 1 && lobbyName) {
      gameState.lobbyName = lobbyName;
    }

    const publicState = {
      players: gameState.players.map(p => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        ready: p.ready,
        isCurrentPlayer: p.id === gameState.players[gameState.currentPlayerIndex]?.id
      })),
      currentPlayerIndex: gameState.currentPlayerIndex,
      direction: gameState.direction,
      gameStarted: gameState.gameStarted,
      winner: gameState.winner,
      topCard: gameState.discardPile[gameState.discardPile.length - 1],
      lastWildChosenColor: gameState.lastWildChosenColor,
      lobbyName: gameState.lobbyName
    };
    socket.emit('gameState', publicState);
    socket.emit('yourHand', { hand: newPlayer.hand });
    socket.emit('setToken', { token: newToken });

    broadcastGameState();
  });

  socket.on('startGame', () => {
    if (gameState.players.length < 2) {
      socket.emit('error', { message: 'Need at least 2 players' });
      return;
    }
    if (gameState.gameStarted) return;

    dealCards();
    gameState.gameStarted = true;
    broadcastGameState();

    for (let player of gameState.players) {
      io.to(player.id).emit('yourHand', { hand: player.hand });
    }
  });

  socket.on('playCard', ({ card, chosenColor }) => {
    const player = gameState.players.find(p => p.id === socket.id);
    if (!player || !gameState.gameStarted) return;
    if (gameState.players[gameState.currentPlayerIndex].id !== socket.id) {
      socket.emit('error', { message: 'Not your turn' });
      return;
    }

    const topCard = gameState.discardPile[gameState.discardPile.length - 1];
    if (!canPlay(card, topCard)) {
      socket.emit('error', { message: 'Invalid move' });
      return;
    }

    const cardIndex = player.hand.findIndex(c =>
      JSON.stringify(c) === JSON.stringify(card)
    );
    if (cardIndex === -1) return;
    player.hand.splice(cardIndex, 1);

    let skipNext = false;
    if (card.type === 'wild') {
      card.chosenColor = chosenColor;
      gameState.lastWildChosenColor = chosenColor;
      if (card.action === 'wild4') {
        const effect = applyCardEffect(card, gameState, gameState.currentPlayerIndex);
        skipNext = effect.skipNext;
      }
    } else if (card.type === 'action') {
      const effect = applyCardEffect(card, gameState, gameState.currentPlayerIndex);
      skipNext = effect.skipNext;
    }

    gameState.discardPile.push(card);

    if (player.hand.length === 0) {
      gameState.winner = player;
      gameState.gameStarted = false;
      broadcastGameState();
      return;
    }

    nextTurn(skipNext);
    io.to(socket.id).emit('yourHand', { hand: player.hand });
  });

  socket.on('drawCard', () => {
    const player = gameState.players.find(p => p.id === socket.id);
    if (!player || !gameState.gameStarted) return;
    if (gameState.players[gameState.currentPlayerIndex].id !== socket.id) {
      socket.emit('error', { message: 'Not your turn' });
      return;
    }

    if (gameState.deck.length === 0) {
      const topCard = gameState.discardPile.pop();
      gameState.deck = shuffle([...gameState.discardPile]);
      gameState.discardPile = [topCard];
    }

    const drawnCard = gameState.deck.pop();
    player.hand.push(drawnCard);

    const topCard = gameState.discardPile[gameState.discardPile.length - 1];
    if (canPlay(drawnCard, topCard)) {
      socket.emit('canPlayDrawnCard', { card: drawnCard });
    } else {
      nextTurn(false);
    }

    io.to(socket.id).emit('yourHand', { hand: player.hand });
  });

  socket.on('callUno', () => {
    const player = gameState.players.find(p => p.id === socket.id);
    if (player && player.hand.length === 1) {
      socket.emit('unoCalled', { message: 'UNO!' });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Do NOT remove the player – they may reconnect later.
    // Optionally, you could set a timeout to clean up after X minutes,
    // but for simplicity we keep them.
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});