const venom = require('venom-bot');
const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000; // Cada instancia usará un puerto diferente
const SESSION_NAME = process.env.SESSION_NAME || 'default_session'; 

let client;

venom.create({
    session: SESSION_NAME, // Nombre único por instancia
    multidevice: true, // Para sesiones persistentes
}).then((bot) => {
    client = bot;
    console.log(`✅ ${SESSION_NAME} conectado en puerto ${PORT}`);
}).catch((error) => {
    console.error(`❌ Error en ${SESSION_NAME}:`, error);
});

// Endpoint para enviar mensajes
app.post('/send', async (req, res) => {
    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({ error: 'Número y mensaje requeridos' });

    try {
        await client.sendText(`${number}@c.us`, message);
        res.json({ success: true, message: `Mensaje enviado a ${number}` });
    } catch (error) {
        res.status(500).json({ error: 'Error enviando mensaje', details: error });
    }
});

// Endpoint para obtener el QR
app.get('/qr', async (req, res) => {
    if (!client) return res.status(500).json({ error: 'Cliente no inicializado' });

    client.on('qr', (qr) => {
        res.json({ qr });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 API de WhatsApp corriendo en http://localhost:${PORT}`);
});
