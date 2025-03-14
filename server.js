const dotenv = require('dotenv');

if (!process.env.PORT) {
  dotenv.config(); // Solo carga .env si no se usa PM2
}

const express = require('express');
const venom = require('venom-bot');
const path = require('path');

const app = express();
app.use(express.json());

// Config
const PORT = process.env.PORT || 3000;
const SESSION_NAME = process.env.SESSION_NAME || 'default_session';
const COMPANY_NAME = process.env.COMPANY_NAME || 'Empresa Desconocida';
const CLIENT_ID = process.env.CLIENT_ID || '0000';
const ACCESS_KEY = process.env.ACCESS_KEY || 'Null';


let client = null;
let qrBase64 = null;
let isClientConnected = false;
let healthCheckInterval = null;

// Función para iniciar Venom-Bot
function startBot() {
  console.log('🔄 Iniciando sesión de Venom-Bot...');

  venom
    .create({
      session: SESSION_NAME,
      multidevice: true,
      headless: true,
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
      // Reintenta al cabo de 5s si falla
      setTimeout(startBot, 5000);
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

// Middleware para autenticar usando la ACCESS_KEY
function authenticateRequest(req, res, next) {
  const authHeader = req.headers.authorization;
  console.log("🚀 Headers authorization:", req.headers.authorization);

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado: Falta el token' });
  }

  const token = authHeader.split(' ')[1];
  console.log("🚀 Token recibido:", token);
  console.log("🚀 Esperaba:", ACCESS_KEY);

  if (token !== ACCESS_KEY) {
    return res.status(403).json({ error: 'Acceso denegado: Clave incorrecta' });
  }

  next(); // Si la autenticación es correcta, pasa al siguiente middleware
}


// Iniciamos el bot al arrancar
startBot();

// Endpoint para enviar mensajes
app.post('/send', authenticateRequest, async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) {
    return res.status(400).json({ error: 'Número y mensaje requeridos' });
  }

  if (!isClientConnected || !client) {
    return res.status(500).json({ error: 'Cliente no conectado. Esperando reconexión...' });
  }

  try {
    await client.sendText(`${number}@c.us`, message);
    res.json({ success: true, message: `Mensaje enviado a ${number}` });
  } catch (error) {
    res.status(500).json({ error: 'Error enviando mensaje', details: error });
  }
});

app.get('/status', (req, res) => {
  // isClientConnected es la variable que ya manejas
  // true = conectado, false = no conectado
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

  // Si la clave es correcta, servimos el HTML
  res.sendFile(path.join(__dirname, 'public', 'qr.html'));
});


app.use(express.static('public'));

app.listen(PORT, () => {
  console.log(`🚀 API de WhatsApp corriendo en http://localhost:${PORT}`);
});
