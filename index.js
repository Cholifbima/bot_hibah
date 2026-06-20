const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 80;

let sock = null;
let currentQR = null;
let isConnected = false;

const routes = express.Router();

routes.get('/', (req, res) => {
    res.redirect((req.baseUrl || '') + '/qr');
});

routes.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send('<h2 style="text-align:center; margin-top:20vh; font-family:sans-serif; color:green;">✅ Bot WhatsApp sudah terhubung! Tidak perlu scan QR.</h2>');
    }
    
    if (currentQR) {
        res.send(`
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:sans-serif; background-color:#f0f2f5;">
                <h2 style="color:#333;">Scan QR Code untuk Login TopAssist Bot</h2>
                <div style="background:#fff; padding:20px; border-radius:15px; box-shadow:0 4px 12px rgba(0,0,0,0.1);">
                    <img src="${currentQR}" alt="QR Code" style="width: 300px; height: 300px;" />
                </div>
                <p style="color:#666; margin-top:15px;">Refresh halaman ini jika QR kedaluwarsa.</p>
            </div>
        `);
    } else {
        res.send('<h2 style="text-align:center; margin-top:20vh; font-family:sans-serif;">⏳ Sedang menyiapkan WhatsApp... Silakan refresh halaman ini 10 detik lagi.</h2>');
    }
});

routes.post('/api/send-message', async (req, res) => {
    try {
        const { secretKey, number, message } = req.body;

        if (secretKey !== (process.env.WA_BOT_SECRET || 'topassist_rahasia_123')) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!number || !message) {
            return res.status(400).json({ error: 'Number dan message wajib diisi' });
        }

        if (!sock) {
            return res.status(500).json({ error: 'WhatsApp client belum siap. Coba lagi dalam beberapa detik.' });
        }

        // Tunggu maksimal 10 detik jika bot sedang dalam proses koneksi ulang (waking up dari cPanel)
        let retries = 0;
        while (!isConnected && retries < 10) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            retries++;
        }

        if (!isConnected) {
            return res.status(500).json({ error: 'WhatsApp sedang terputus atau mencoba reconnect. Coba sesaat lagi.' });
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

app.use('/', routes);
app.use('/botwa', routes);

async function connectToWhatsApp() {
    // Memastikan folder auth berada di tempat yang benar dan tidak berpindah
    const authFolder = path.join(__dirname, 'auth_info_baileys');
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ['TopAssist Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if(qr) {
            console.log('\n=== SCAN QR CODE INI UNTUK LOGIN WHATSAPP BOT ===\n');
            currentQR = await qrcode.toDataURL(qr);
        }

        if(connection === 'close') {
            isConnected = false;
            currentQR = null;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if(shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000); // Beri jeda sedikit sebelum reconnect agar tidak spam
            } else {
                console.log('Session dihapus. Hapus folder auth_info_baileys dan jalankan ulang untuk scan QR.');
            }
        } else if(connection === 'open') {
            isConnected = true;
            currentQR = null;
            console.log('✅ WA Bot Terhubung Permanen!');
        }
    });
}

app.listen(PORT, () => {
    console.log('🤖 WhatsApp Bot API berjalan di port ' + PORT);
    connectToWhatsApp();
});
