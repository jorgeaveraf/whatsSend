const express = require('express');
const wppconnect = require('@wppconnect-team/wppconnect');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const multer = require('multer');
const cron = require('node-cron');

if (!process.env.PORT) {
  dotenv.config();
}

const app = express();
app.use(express.json());

// Config
const PORT = process.env.PORT || 3000;
const SESSION_NAME = process.env.SESSION_NAME || 'default_session';
const SESSION_DIR = path.join(__dirname, 'tokens', SESSION_NAME);
const COMPANY_NAME = process.env.COMPANY_NAME || 'Empresa Desconocida';
const ACCESS_KEY = process.env.ACCESS_KEY || 'Null';
const N8N_WEBHOOK = process.env.N8N_WEBHOOK || 'https://n8n.scolaris.com/webhook/whatsapp-messages';
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const MAX_BUFFER_SIZE = 100;

let client = null;
let qrBase64 = null;
let isClientConnected = false;
let isStartingClient = false;
let messageAuditQueue = [];
let healthCheckInterval = null;
let retryCount = 0;
const MAX_RETRIES = 5;

// Storage
const upload = multer({ dest: 'public/uploads/' });

// Helpers
function authenticateRequest(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado: Falta el token' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== ACCESS_KEY) {
    return res.status(403).json({ error: 'Acceso denegado: Clave incorrecta' });
  }
  next();
}

async function sendToN8N(data) {
  console.log('🚀 Enviando datos a n8n:', JSON.stringify(data, null, 2));
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    console.log('✅ Respuesta de n8n:', await response.text());
  } catch (err) {
    console.error('❌ Error al enviar mensaje a n8n:', err);
  }
}

function storeInAuditQueue(data) {
  if (messageAuditQueue.length >= MAX_BUFFER_SIZE) {
    messageAuditQueue.shift();
  }
  messageAuditQueue.push({ ...data, timestamp: Date.now() });
}

function cleanupSessionDir() {
  try {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    console.log('🧹 Directorio de sesión limpiado.');
  } catch (err) {
    console.warn('⚠️ No se pudo limpiar sesión:', err.message);
  }
}

// WPPConnect bootstrap
async function startClient() {
  if (isStartingClient) {
    console.log('⏳ startClient ya en progreso, se omite nuevo arranque.');
    return;
  }
  isStartingClient = true;
  console.log('🔄 Iniciando sesión con WPPConnect...');
  qrBase64 = null;

  try {
    client = await wppconnect.create({
      session: SESSION_NAME,
      catchQR: (base64Qr, asciiQR, attempts) => {
        qrBase64 = base64Qr.startsWith('data:') ? base64Qr : `data:image/png;base64,${base64Qr}`;
        console.log('⚡ [QR Capturado]', qrBase64.slice(0, 60) + '...', 'intentos:', attempts);
        if (asciiQR) console.log(asciiQR);
      },
      onLoadingScreen: (percent, message) => {
        console.log('⏳ Cargando WhatsApp', percent, message);
      },
      statusFind: (status) => {
        console.log('📌 Estado de sesión:', status);
        if (status === 'qrReadSuccess' || status === 'inChat' || status === 'isLogged') {
          isClientConnected = true;
        }
      },
      headless: 'new',
      logQR: false,
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        `--user-data-dir=${SESSION_DIR}`,
      ],
      disableSpins: true,
      defaultViewport: null,
      waitForLogin: true,
      autoClose: 0,
    });

    isStartingClient = false;
    isClientConnected = true;
    retryCount = 0;
    startHealthCheck();

    client.onMessage(async (message) => {
      console.log('📩 Nuevo mensaje recibido:', message);
      const chatId = message.from;
      const isGroup = message.isGroupMsg;
      if (isGroup) {
        console.log(`📵 Ignorado: mensaje de grupo (${chatId})`);
        return;
      }
      const from = chatId.replace(/\D/g, '');
      try {
        if (message.isMedia || message.isMMS) {
          const buffer = await client.decryptFile(message);
          if (!buffer) return;
          const mimetype = message.mimetype || 'application/octet-stream';
          const extension = mimetype.split('/')[1] || 'bin';
          const fileName = `${from}-${Date.now()}.${extension}`;
          const filePath = path.join(__dirname, 'public/uploads', fileName);
          await fs.promises.writeFile(filePath, buffer);
          const fileUrl = `${BASE_URL}/uploads/${fileName}`;

          const msg = { from, type: message.type, mimetype, filename: fileName, fileUrl };
          await sendToN8N(msg);
          storeInAuditQueue(msg);
        } else if (message.type === 'chat' || message.type === 'text') {
          await sendToN8N({ from, text: message.body });
          storeInAuditQueue({ from, type: message.type, text: message.body });
        } else {
          console.log(`ℹ️ Tipo de mensaje no manejado: ${message.type}`);
        }
      } catch (err) {
        console.error('❌ Error general en procesamiento de mensaje:', err);
        storeInAuditQueue({ from, error: err.message || 'fallo desconocido', type: message.type });
      }
    });
  } catch (err) {
    console.error('❌ Error al iniciar WPPConnect:', err);
    const msg = (err && err.message) ? err.message : String(err);

    // Si el navegador ya está corriendo con el mismo userDataDir,
    // limpiamos la carpeta de sesión para evitar bucles de reintentos.
    if (msg.includes('The browser is already running')) {
      console.warn('⚠️ Navegador previo detectado para la sesión. Limpiando tokens y reintentando...');
      cleanupSessionDir();
    }

    isStartingClient = false;
    isClientConnected = false;
    if (retryCount >= MAX_RETRIES) {
      console.error('🚫 Límite de reintentos alcanzado.');
      return;
    }
    retryCount++;
    const retryDelay = 5000 * Math.pow(2, retryCount - 1);
    setTimeout(startClient, retryDelay);
  }
}

function startHealthCheck() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = setInterval(async () => {
    if (!client) return;
    try {
      const state = await client.getConnectionState();
      isClientConnected = state === 'CONNECTED';
      if (!isClientConnected) {
        console.log('⚠️ HealthCheck: cliente desconectado, reiniciando...');
        startClient();
      }
    } catch (err) {
      console.log('Error en healthCheck:', err);
      startClient();
    }
  }, 30000);
}

// Routes
app.post('/send', authenticateRequest, upload.single('file'), async (req, res) => {
  const { number, message, caption, fileUrl, fileName } = req.body;
  const file = req.file;
  if (!number) return res.status(400).json({ error: 'El número es requerido' });
  if (!isClientConnected || !client) return res.status(500).json({ error: 'Cliente no conectado.' });

  const to = `${number}@c.us`;
  try {
    if (message && !file && !fileUrl) {
      await client.sendText(to, message);
      return res.json({ success: true, message: 'Mensaje de texto enviado' });
    }

    if (fileUrl) {
      await client.sendFile(to, fileUrl, fileName || path.basename(fileUrl), caption || '');
      return res.json({ success: true, message: 'Archivo enviado desde URL' });
    }

    if (file) {
      await client.sendFile(to, file.path, file.originalname, caption || '');
      fs.unlink(file.path, () => {});
      return res.json({ success: true, message: 'Archivo enviado desde binario' });
    }

    return res.status(400).json({ error: 'Debes enviar un mensaje o archivo (URL o binario)' });
  } catch (err) {
    console.error('❌ Error enviando mensaje:', err);
    return res.status(500).json({ error: 'Error enviando mensaje', details: err.message });
  }
});

app.get('/status', (req, res) => {
  res.json({ connected: isClientConnected });
});

app.get('/qr-data', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado: Falta el token' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== ACCESS_KEY) {
    return res.status(403).json({ error: 'Acceso denegado: Clave incorrecta' });
  }
  if (!qrBase64) {
    return res.status(404).json({ status: false, message: 'QR aún no generado. Espera unos segundos...' });
  }
  res.json({ status: true, data: qrBase64 });
});

app.get('/config', (req, res) => {
  res.json({
    companyName: COMPANY_NAME,
    termsUrl: 'https://scolaris.com.mx',
    accessKey: ACCESS_KEY,
  });
});

app.get('/qr', (req, res) => {
  const userKey = req.query.key;
  if (!userKey || userKey !== ACCESS_KEY) {
    return res.status(401).send('No autorizado: clave incorrecta');
  }
  res.sendFile(path.join(__dirname, 'public', 'qr.html'));
});

app.post('/restart-bot', authenticateRequest, async (_req, res) => {
  console.log('🔁 Reinicio manual solicitado');
  try {
    if (client) await client.close();
  } catch (err) {
    console.error('⚠️ Error cerrando sesión:', err);
  }
  isClientConnected = false;
  retryCount = 0;
  cleanupSessionDir();
  startClient();
  res.json({ success: true, message: 'Bot reiniciado manualmente' });
});

app.get('/audit', authenticateRequest, (_req, res) => {
  res.json({ messages: messageAuditQueue });
});

app.use(express.static('public'));

// Limpieza de archivos antiguos
cron.schedule('0 3 * * *', async () => {
  const uploadsDir = path.join(__dirname, 'public/uploads');
  try {
    const files = await fs.promises.readdir(uploadsDir);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(uploadsDir, file);
      const stats = await fs.promises.stat(filePath);
      if (now - stats.mtimeMs > 1000 * 60 * 60 * 24) {
        await fs.promises.unlink(filePath);
        console.log(`🧹 Archivo eliminado por antigüedad: ${file}`);
      }
    }
  } catch (err) {
    console.error('❌ Error al limpiar archivos antiguos:', err);
  }
});

// Start
startClient();

app.listen(PORT, () => {
  console.log(`🚀 API de WhatsApp corriendo en http://localhost:${PORT}`);
});
