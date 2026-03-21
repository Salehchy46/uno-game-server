// Card definitions
const colors = ['red', 'green', 'blue', 'yellow'];
const numbers = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const actions = ['skip', 'reverse', 'draw2'];
const wilds = ['wild', 'wild4'];

function createDeck() {
  let deck = [];
  
  // Number cards (0-9, two of each except 0)
  for (let color of colors) {
    for (let num of numbers) {
      deck.push({ type: 'number', color, value: num });
      if (num !== '0') deck.push({ type: 'number', color, value: num });
    }
  }
  
  // Action cards
  for (let color of colors) {
    for (let action of actions) {
      deck.push({ type: 'action', color, action });
      deck.push({ type: 'action', color, action });
    }
  }
  
  // Wild cards
  for (let i = 0; i < 4; i++) {
    deck.push({ type: 'wild', action: 'wild' });
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ type: 'wild', action: 'wild4' });
  }
  
  return shuffle(deck);
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function canPlay(card, topCard) {
  if (card.type === 'wild') return true;
  if (topCard.type === 'wild') {
    return card.color === topCard.chosenColor;
  }
  if (card.color === topCard.color) return true;
  if (card.type === 'number' && topCard.type === 'number' && card.value === topCard.value) return true;
  if (card.type === 'action' && topCard.type === 'action' && card.action === topCard.action) return true;
  return false;
}

function applyCardEffect(card, gameState, currentPlayer) {
  const nextPlayer = (gameState.direction === 1) ? 
    (currentPlayer + 1) % gameState.players.length : 
    (currentPlayer - 1 + gameState.players.length) % gameState.players.length;
    
  switch (card.action) {
    case 'skip':
      return { skipNext: true };
    case 'reverse':
      gameState.direction *= -1;
      return { skipNext: false };
    case 'draw2':
      for (let i = 0; i < 2; i++) {
        const drawn = gameState.deck.pop();
        if (drawn) gameState.players[nextPlayer].hand.push(drawn);
      }
      return { skipNext: true };
    case 'wild4':
      for (let i = 0; i < 4; i++) {
        const drawn = gameState.deck.pop();
        if (drawn) gameState.players[nextPlayer].hand.push(drawn);
      }
      return { skipNext: true };
    default:
      return { skipNext: false };
  }
}

export { createDeck, shuffle, canPlay, applyCardEffect };