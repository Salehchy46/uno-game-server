import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { createDeck, canPlay, applyCardEffect } from './gameLogic.js';

const app = express();
app.use(cors());
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
  players: [],        // { id, name, hand, ready }
  deck: [],
  discardPile: [],
  currentPlayerIndex: 0,
  direction: 1,      // 1 = clockwise, -1 = counter-clockwise
  gameStarted: false,
  winner: null,
  lastWildChosenColor: null
};

// Maximum players increased to 10
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
    lastWildChosenColor: gameState.lastWildChosenColor
  };
  io.emit('gameState', publicState);
}

function dealCards() {
  const deck = createDeck();
  gameState.deck = deck;
  gameState.discardPile = [];
  
  // Deal 7 cards to each player
  for (let player of gameState.players) {
    player.hand = [];
    for (let i = 0; i < 7; i++) {
      player.hand.push(gameState.deck.pop());
    }
  }
  
  // Initial discard
  let topCard = gameState.deck.pop();
  while (topCard.type === 'wild') {
    gameState.deck.unshift(topCard);
    topCard = gameState.deck.pop();
  }
  gameState.discardPile.push(topCard);
  
  // Determine starting player (first in list)
  gameState.currentPlayerIndex = 0;
  gameState.direction = 1;
}

function nextTurn(skipPlayer = false) {
  if (skipPlayer) {
    gameState.currentPlayerIndex = (gameState.currentPlayerIndex + gameState.direction + gameState.players.length) % gameState.players.length;
  }
  gameState.currentPlayerIndex = (gameState.currentPlayerIndex + gameState.direction + gameState.players.length) % gameState.players.length;
  
  // Check if game is over
  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  if (currentPlayer.hand.length === 0) {
    gameState.winner = currentPlayer;
    gameState.gameStarted = false;
  }
  
  broadcastGameState();
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('joinGame', ({ name }) => {
    if (gameState.gameStarted) {
      socket.emit('error', { message: 'Game already in progress' });
      return;
    }
    if (gameState.players.length >= MAX_PLAYERS) {
      socket.emit('error', { message: `Game is full (max ${MAX_PLAYERS} players)` });
      return;
    }
    
    const newPlayer = {
      id: socket.id,
      name: name || `Player ${gameState.players.length + 1}`,
      hand: [],
      ready: false
    };
    gameState.players.push(newPlayer);
    socket.join('game');
    
    // Send current game state to new player
    const privateState = {
      hand: newPlayer.hand,
      ...gameState
    };
    socket.emit('gameState', privateState);
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
    
    // Send full hand to each player
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
    
    // Remove card from hand
    const cardIndex = player.hand.findIndex(c => 
      JSON.stringify(c) === JSON.stringify(card)
    );
    if (cardIndex === -1) return;
    player.hand.splice(cardIndex, 1);
    
    // Apply special effects
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
    
    // Add to discard pile
    gameState.discardPile.push(card);
    
    // Check win
    if (player.hand.length === 0) {
      gameState.winner = player;
      gameState.gameStarted = false;
      broadcastGameState();
      return;
    }
    
    // Move to next player
    nextTurn(skipNext);
    
    // Send updated hand to player
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
      // Reshuffle discard pile except top card
      const topCard = gameState.discardPile.pop();
      gameState.deck = shuffle([...gameState.discardPile]);
      gameState.discardPile = [topCard];
    }
    
    const drawnCard = gameState.deck.pop();
    player.hand.push(drawnCard);
    
    // Check if drawn card can be played
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
      // Mark that UNO was called
      socket.emit('unoCalled', { message: 'UNO!' });
    }
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const index = gameState.players.findIndex(p => p.id === socket.id);
    if (index !== -1) {
      gameState.players.splice(index, 1);
      if (gameState.gameStarted && gameState.players.length < 2) {
        gameState.gameStarted = false;
        gameState.winner = null;
      }
      broadcastGameState();
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
}); 

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});