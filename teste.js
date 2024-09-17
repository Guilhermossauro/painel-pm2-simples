const WebSocket = require('ws');

// Substitua pela URL do seu WebSocket
const ws = new WebSocket('ws://168.228.20.74:3011'); 

ws.on('open', () => {
  console.log('Conectado ao WebSocket.');

  // Envia uma mensagem de teste
  const testMessage = JSON.stringify({ processId: 'test' });
  ws.send(testMessage);
  console.log('Mensagem de teste enviada:', testMessage);
});

ws.on('message', (message) => {
  console.log('Mensagem recebida do servidor:', message);
});

ws.on('error', (error) => {
  console.error('Erro WebSocket:', error);
});

ws.on('close', () => {
  console.log('Conexão WebSocket fechada.');
});
