const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

let sock = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }), // Ganti ke 'info' jika butuh logs
        browser: ['TopAssist Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if(qr) {
            console.log('\n=== SCAN QR CODE INI UNTUK LOGIN WHATSAPP BOT ===\n');
        }

        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if(shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Session dihapus. Hapus folder auth_info_baileys dan jalankan ulang untuk scan QR.');
            }
        } else if(connection === 'open') {
            console.log('✅ WA Bot Terhubung!');
        }
    });
}

// Endpoint internal untuk menerima perintah kirim pesan dari Backend utama
app.post('/api/send-message', async (req, res) => {
    try {
        const { secretKey, number, message } = req.body;

        if (secretKey !== (process.env.WA_BOT_SECRET || 'topassist_rahasia_123')) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!number || !message) {
            return res.status(400).json({ error: 'Number dan message wajib diisi' });
        }

        if (!sock) {
            return res.status(500).json({ error: 'WhatsApp client belum siap' });
        }

        let formattedNumber = number.replace(/\D/g, '');
        if (formattedNumber.startsWith('0')) {
            formattedNumber = '62' + formattedNumber.substring(1);
        }
        
        const jid = formattedNumber + '@s.whatsapp.net';

        await sock.sendMessage(jid, { text: message });

        res.json({ success: true, message: 'Pesan berhasil dikirim ke ' + formattedNumber });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ error: 'Gagal mengirim pesan' });
    }
});

app.listen(PORT, () => {
    console.log(`🤖 WhatsApp Bot API berjalan di port ${PORT}`);
    connectToWhatsApp();
});
