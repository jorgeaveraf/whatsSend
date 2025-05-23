const express = require('express');
const venom = require('venom-bot');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

if (!process.env.PORT) {
  dotenv.config(); // Solo carga .env si no se usa PM2
}

const app = express();
app.use(express.json());

// Config
const PORT = process.env.PORT || 3000;
const SESSION_NAME = process.env.SESSION_NAME || 'default_session';
const COMPANY_NAME = process.env.COMPANY_NAME || 'Empresa Desconocida';
const CLIENT_ID = process.env.CLIENT_ID || '0000';
const ACCESS_KEY = process.env.ACCESS_KEY || 'Null';
const N8N_WEBHOOK = process.env.N8N_WEBHOOK || 'https://n8n.scolaris.com/webhook/whatsapp-messages';
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;


let client = null;
let qrBase64 = null;
let isClientConnected = false;
let healthCheckInterval = null;
let retryCount = 0;
const MAX_RETRIES = 5;
const MAX_BUFFER_SIZE = 100; // últimos 100 mensajes
let messageAuditQueue = [];
const multer = require('multer');
const upload = multer({ dest: 'public/uploads/' });



// ========== Helpers & Middlewares ==========

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
  console.log("🚀 Enviando datos a n8n:", JSON.stringify(data, null, 2));

  try {
    const response = await fetch(N8N_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });

    const responseBody = await response.text();
    console.log("✅ Respuesta de n8n:", responseBody);
  } catch (error) {
    console.error("❌ Error al enviar mensaje a n8n:", error);
  }
}

function storeInAuditQueue(data) {
  if (messageAuditQueue.length >= MAX_BUFFER_SIZE) {
    messageAuditQueue.shift(); // elimina el más antiguo
  }
  messageAuditQueue.push({
    ...data,
    timestamp: Date.now()
  });
}



// Función para iniciar Venom-Bot
function startBot() {
  console.log('🔄 Iniciando sesión de Venom-Bot...');

  venom
    .create({
      session: SESSION_NAME,
      multidevice: true,
      headless: 'new',
      catchQR: (base64Qr) => {
        qrBase64 = base64Qr;
        console.log('⚡ [QR Capturado]', base64Qr.slice(0, 60) + '...');
      },
    })
    .then((bot) => {
      client = bot;
      isClientConnected = true;
      console.log(`✅ ${SESSION_NAME} conectado en puerto ${PORT}`);

      // Activamos un timer para chequear la conexión cada 30s
      startHealthCheck();

      client.onMessage(async (message) => {
        console.log("📩 Nuevo mensaje recibido:", message);

        const isGroup = message.chatId?.endsWith('@g.us');
        const isBroadcast = message.chatId === 'status@broadcast';
        const isDirectUser = message.chatId?.endsWith('@c.us');

        if (!isDirectUser || isGroup || isBroadcast) {
          console.log(`📵 Ignorado: mensaje no deseado (${message.chatId})`);
          return;
        }


        const ignoredTypes = ['sticker', 'location', 'vcard'];
        if (ignoredTypes.includes(message.type)) {
          console.log(`🚫 Mensaje tipo ${message.type} ignorado.`);
          return;
        }
      
        const from = message.from.replace(/\D/g, ''); // Limpia el número de teléfono
      
        try {
          // 🎞️ Imágenes, videos, audios, documentos
          if (message.isMedia || message.isMMS || message.type === 'image' || message.type === 'video' || message.type === 'document' || message.type === 'audio' || message.type === 'ptt') {
            console.log(`📥 Archivo detectado. Tipo: ${message.type}, MIME: ${message.mimetype}`);
      
            const buffer = await client.decryptFile(message); // 🎯 Usa decryptFile para obtener el archivo
            if (!buffer) {
              console.error("❌ Error: El archivo no pudo ser descargado o desencriptado.");
              return;
            }
      
            if (!message.mimetype) {
              console.warn("⚠️ Archivo recibido sin mimetype, ignorado.");
              return;
            }            

            const extension = message.mimetype?.split("/")[1] || "bin";
            const fileName = `${from}-${Date.now()}.${extension}`;
            const filePath = path.join(__dirname, 'public/uploads', fileName);
            await fs.promises.writeFile(filePath, buffer);
            console.log("📁 Archivo guardado en:", filePath);
      
            const fileUrl = `${BASE_URL}/uploads/${fileName}`;

      
            // 🧠 Clasificamos el tipo para n8n según prioridad de procesamiento
            const messageForN8n = {
              from,
              type: message.type,
              mimetype: message.mimetype,
              filename: fileName,
              fileUrl
            };
      
            await sendToN8N(messageForN8n);
            storeInAuditQueue(messageForN8n);
          }
      
          // ✉️ Mensajes de texto
          else if (message.type === 'chat' || message.type === 'text') {
            await sendToN8N({ from, text: message.body });
            storeInAuditQueue({
              from,
              type: message.type,
              text: message.body
            });
          }
      
          // 🔇 Otros tipos de mensaje que no procesamos
          else {
            console.log(`ℹ️ Tipo de mensaje no manejado: ${message.type}`);
          }
      
        } catch (error) {
          console.error("❌ Error general en procesamiento de mensaje:", error);
          storeInAuditQueue({
            from,
            error: error.message || 'fallo desconocido',
            type: message.type
          });          
        }
      });    
    

      // Manejo de estados
      client.onStateChange(async (state) => {
        console.log('📡 Estado del cliente:', state);
        // Verificamos estados que implican desconexión inmediata
        if (['CONFLICT', 'UNPAIRED', 'UNLAUNCHED', 'DISCONNECTED', 'TIMEOUT'].some(s => state.includes(s))) {
          console.log('⚠️ Cliente desconectado según onStateChange. Forzando reinicio...');
          await forceRestart();
        }
      });
    })
    .catch((err) => {
      console.error('❌ Error al iniciar Venom-Bot:', err);
    
      if (retryCount >= MAX_RETRIES) {
        console.error('🚫 Límite de reintentos alcanzado. Deteniendo reinicio automático.');
        return;
      }
    
      retryCount++;
      const retryDelay = 5000 * Math.pow(2, retryCount - 1); // 5s, 10s, 20s, 40s, 80s...
    
      console.log(`⏳ Reintentando en ${retryDelay / 1000}s... (Intento ${retryCount}/${MAX_RETRIES})`);
      setTimeout(startBot, retryDelay);
    });
    
}

// Timer que hace ping cada 30s
function startHealthCheck() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);

  healthCheckInterval = setInterval(async () => {
    if (!client) return;
    try {
      const connected = await client.isConnected();
      if (!connected) {
        console.log('⚠️ HealthCheck: ¡No hay conexión! Forzando reinicio...');
        await forceRestart();
      }
    } catch (err) {
      console.log('Error en healthCheck:', err);
      // Si da error en el chequeo, también podemos forzar un reinicio.
      await forceRestart();
    }
  }, 30000); // cada 30s
}

// Forzar el cierre + reinicio del bot
async function forceRestart() {
  try {
    if (client) {
      await client.close();
    }
  } catch (err) {
    console.error('Error cerrando el cliente:', err);
  }
  isClientConnected = false;
  restartBot();
}

// Para reiniciar después de 10s
function restartBot() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  console.log('🔄 Reiniciando bot en 10s...');
  setTimeout(() => {
    startBot();
  }, 10000);
}

// Iniciamos el bot al arrancar
startBot();

app.post('/send', authenticateRequest, upload.single('file'), async (req, res) => {
  const { number, message, caption, fileUrl, fileName } = req.body;
  const file = req.file;

  if (!number) {
    return res.status(400).json({ error: 'El número es requerido' });
  }

  if (!isClientConnected || !client) {
    return res.status(500).json({ error: 'Cliente no conectado. Esperando reconexión...' });
  }

  const to = `${number}@c.us`;

  try {
    // 1️⃣ Solo texto
    if (message && !file && !fileUrl) {
      await client.sendText(to, message);
      return res.json({ success: true, message: 'Mensaje de texto enviado' });
    }

    // 2️⃣ Desde URL
    if (fileUrl) {
      const ext = path.extname(fileUrl).toLowerCase();
      const safeFileName = fileName || path.basename(fileUrl);

      if (['.jpg', '.jpeg', '.png'].includes(ext)) {
        await client.sendImage(to, fileUrl, safeFileName, caption || '');
        return res.json({ success: true, message: 'Imagen enviada desde URL' });
      }

      if (['.pdf', '.docx', '.xlsx', '.txt'].includes(ext)) {
        await client.sendFile(to, fileUrl, safeFileName, caption || '');
        return res.json({ success: true, message: 'Archivo enviado desde URL' });
      }

      if (['.mp3', '.ogg'].includes(ext)) {
        await client.sendFile(to, fileUrl, safeFileName, caption || '');
        return res.json({ success: true, message: 'Audio enviado desde URL' });
      }

      return res.status(400).json({ error: 'Extensión de archivo no soportada desde URL' });
    }

    // 3️⃣ Desde archivo binario (form-data)
    if (file) {
      const ext = path.extname(file.originalname).toLowerCase();
      const filePath = file.path;
      const localFileName = file.originalname;

      if (['.jpg', '.jpeg', '.png'].includes(ext)) {
        await client.sendImage(to, filePath, localFileName, caption || '');
        return res.json({ success: true, message: 'Imagen enviada desde archivo' });
      }

      if (['.pdf', '.docx', '.xlsx', '.txt'].includes(ext)) {
        await client.sendFile(to, filePath, localFileName, caption || '');
        return res.json({ success: true, message: 'Archivo enviado desde archivo' });
      }

      if (['.mp3', '.ogg'].includes(ext)) {
        await client.sendFile(to, filePath, localFileName, caption || '');
        return res.json({ success: true, message: 'Audio enviado desde archivo' });
      }

      return res.status(400).json({ error: 'Tipo de archivo no soportado desde archivo' });
    }

    return res.status(400).json({ error: 'Debes enviar un mensaje o un archivo (URL o binario)' });

  } catch (error) {
    console.error("❌ Error enviando mensaje:", error);
    return res.status(500).json({ error: 'Error enviando mensaje', details: error.message });
  }
});



app.get('/status', (req, res) => {
  res.json({ connected: isClientConnected });
});


// Endpoint para devolver el QR
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


// Endpoint para config
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

app.post('/restart-bot', authenticateRequest, async (req, res) => {
  console.log('🔁 Reinicio manual del bot solicitado');

  try {
    if (client) {
      console.log('🧹 Cerrando sesión actual antes de reiniciar...');
      await client.close();
    }
  } catch (err) {
    console.error('⚠️ Error al cerrar sesión previa:', err);
  }

  retryCount = 0; // Reiniciamos contador de reintentos
  startBot();     // Relanzamos
  res.json({ success: true, message: 'Bot reiniciado manualmente' });
});

app.get('/audit', authenticateRequest, (req, res) => {
  res.json({ messages: messageAuditQueue });
});


app.use(express.static('public'));

// Limpieza automática de archivos antiguos (cada noche a las 3am)
const cron = require('node-cron');

cron.schedule('0 3 * * *', async () => {
  const uploadsDir = path.join(__dirname, 'public/uploads');
  try {
    const files = await fs.promises.readdir(uploadsDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(uploadsDir, file);
      const stats = await fs.promises.stat(filePath);
      const age = now - stats.mtimeMs;
      
      if (age > 1000 * 60 * 60 * 24) { // 24 horas
        await fs.promises.unlink(filePath);
        console.log(`🧹 Archivo eliminado por antigüedad: ${file}`);
      }
    }
  } catch (err) {
    console.error("❌ Error al limpiar archivos antiguos:", err);
  }
});


app.listen(PORT, () => {
  console.log(`🚀 API de WhatsApp corriendo en http://localhost:${PORT}`);
});
