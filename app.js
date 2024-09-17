const express = require('express');
const session = require('express-session');
const WebSocket = require('ws');
const http = require('http');
const axios = require('axios');
const pm2 = require('pm2');
const fs = require('fs');
const path = require('path'); // Para resolver caminhos de arquivo
const PORT = 3011;
const AnsiToHtml = require('ansi-to-html');
const ansiToHtmlConverter = new AnsiToHtml();

const IP_ADDRESS = '192.168.1.102';
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: 'secret',
  resave: false,
  saveUninitialized: true,
}));

const VIP_API_URL = 'http://localhost:3200/clientes';

// Middleware de autenticação de usuário
const autenticarUsuario = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const response = await axios.get(VIP_API_URL);

   const usuariosVIP = Array.isArray(response.data) ? response.data : response.data.clientes;
    const usuario = usuariosVIP.find((user) => user.userId === username);

    if (!usuario) {
      console.log('Usuário não encontrado:', username);
      return res.status(401).render('login', { error: 'Usuário não encontrado' });
    }

    if (usuario.kea !== password) {
      console.log('Chave de autenticação incorreta:', password);
      return res.status(401).render('login', { error: 'Chave de autenticação incorreta' });
    }

    req.session.usuario = usuario;
    next();
  } catch (error) {
    console.log(error);
    res.status(500).render('login', { error: 'Erro ao verificar usuário VIP' });
  }
};
// Verifica se o usuário está autenticado
const ensureAuthenticated = (req, res, next) => {
  if (req.session.usuario) return next();
  res.redirect('/login');
};

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', autenticarUsuario, (req, res) => {
  res.redirect('/dashboard');
});

app.get('/dashboard', ensureAuthenticated, (req, res) => {
  pm2.connect(function (err) {
    if (err) {
      console.error(err);
      process.exit(2);
    }

    pm2.list((err, processDescriptionList) => {
      if (err) {
        pm2.disconnect();
        throw err;
      }

      const processLogsPromises = processDescriptionList.map((process) => {
        return new Promise((resolve) => {
          const outLogPath = path.resolve(process.pm2_env.pm_out_log_path);
          const errorLogPath = path.resolve(process.pm2_env.pm_err_log_path);

          fs.readFile(outLogPath, 'utf8', (err, outLog) => {
            fs.readFile(errorLogPath, 'utf8', (err, errorLog) => {
              resolve({
                id: process.pm_id,
                name: process.name,
                memory: (process.monit.memory / 1024 / 1024).toFixed(2),
                outLog: outLog || 'Sem logs de saída',
                errorLog: errorLog || 'Sem logs de erro',
              });
            });
          });
        });
      });

      Promise.all(processLogsPromises).then(processLogs => {
        pm2.disconnect();
        res.render('dashboard', { processes: processLogs });
      });
    });
  });
});

app.post('/process/:id/:action', ensureAuthenticated, (req, res) => {
  const { id, action } = req.params;

  pm2.connect(function (err) {
    if (err) {
      return res.json({ message: 'Erro ao conectar com PM2' });
    }

    pm2[action](id, (err) => {
      pm2.disconnect();
      if (err) {
        return res.json({ message: `Erro ao ${action} processo` });
      }
      res.json({ message: `Processo ${action} com sucesso` });
    });
  });
});

// WebSocket para enviar logs em tempo real
wss.on('connection', function connection(ws) {
  console.log('Novo cliente WebSocket conectado.');

  ws.on('message', function incoming(message) {
    console.log('Mensagem recebida: %s', message);

    const { processId } = JSON.parse(message);

    if (!processId) {
      ws.send(JSON.stringify({ error: 'ID do processo não fornecido' }));
      return;
    }

    pm2.connect(err => {
      if (err) {
        console.error('Erro ao conectar com PM2:', err);
        ws.send(JSON.stringify({ error: 'Erro ao conectar com PM2' }));
        return;
      }

      pm2.describe(processId, (err, processDescription) => {
        if (err) {
          console.error('Erro ao descrever o processo:', err);
          ws.send(JSON.stringify({ error: 'Erro ao descrever o processo' }));
          pm2.disconnect();
          return;
        }

        const outLogPath = processDescription[0].pm2_env.pm_out_log_path;
        const errorLogPath = processDescription[0].pm2_env.pm_err_log_path;

        const sendLogs = () => {
          // Função para ler e enviar o conteúdo de um arquivo
          const sendFileContent = (logPath, logType) => {
            fs.readFile(logPath, 'utf8', (err, data) => {
              if (err) {
                console.error(`Erro ao ler o arquivo ${logType}:`, err);
                ws.send(JSON.stringify({
                  processId,
                  [logType]: `Erro ao ler o log: ${err.message}`
                }));
                return;
              }

              // Converte o conteúdo ANSI para HTML
              const convertedLog = ansiToHtmlConverter.toHtml(data);

              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  processId,
                  [logType]: convertedLog || `Sem logs de ${logType}`
                }));
              }
            });
          };

          // Ler e enviar o conteúdo do log de saída
          sendFileContent(outLogPath, 'outLog');

          // Ler e enviar o conteúdo do log de erro
          sendFileContent(errorLogPath, 'errorLog');
        };

        sendLogs();

        // Assistir mudanças nos arquivos de log
        const outLogWatcher = fs.watch(outLogPath, sendLogs);
        const errorLogWatcher = fs.watch(errorLogPath, sendLogs);

        // Limpar os watchers e desconectar o PM2 ao fechar a conexão WebSocket
        ws.on('close', () => {
          console.log('Cliente WebSocket desconectado.');
          outLogWatcher.close();
          errorLogWatcher.close();
          pm2.disconnect();
        });
      });
    });
  });
});

server.listen(PORT, IP_ADDRESS, () => {
  console.log(`Servidor rodando em ${IP_ADDRESS}:${PORT}`);
});
