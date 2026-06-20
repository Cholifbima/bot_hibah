const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode'); // Tambahan untuk QR Code
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 80;

let sock = null;
let currentQR = null; // Menyimpan status QR terakhir
let isConnected = false;

// Membuat router agar support subfolder cPanel (misal /botwa)
const routes = express.Router();

routes.get('/', (req, res) => {
    // Redirect ke /qr (menambahkan baseUrl agar support subfolder)
    res.redirect((req.baseUrl || '') + '/qr');
});

// 🌐 ENDPOINT BARU: Menampilkan QR code di browser
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
        res.send('<h2 style="text-align:center; margin-top:20vh; font-family:sans-serif;">⏳ Loading QR Code... Silakan refresh beberapa detik lagi.</h2>');
    }
});

// Endpoint internal untuk menerima perintah kirim pesan dari Backend utama
routes.post('/api/send-message', async (req, res) => {
    try {
        const { secretKey, number, message } = req.body;

        if (secretKey !== (process.env.WA_BOT_SECRET || 'topassist_rahasia_123')) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!number || !message) {
            return res.status(400).json({ error: 'Number dan message wajib diisi' });
        }

        if (!sock || !isConnected) {
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

// Pasang router di dua path (agar jalan normal maupun di dalam cPanel botwa)
app.use('/', routes);
app.use('/botwa', routes);

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }), // Ganti ke 'info' jika butuh logs
        browser: ['TopAssist Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    // Event saat butuh scan QR atau koneksi berhasil
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if(qr) {
            console.log('\n=== SCAN QR CODE INI UNTUK LOGIN WHATSAPP BOT ===\n');
            // Generate QR Code menjadi data URL (Base64) agar bisa tampil di browser
            currentQR = await qrcode.toDataURL(qr);
        }

        if(connection === 'close') {
            isConnected = false;
            currentQR = null;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if(shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Session dihapus. Hapus folder auth_info_baileys dan jalankan ulang untuk scan QR.');
            }
        } else if(connection === 'open') {
            isConnected = true;
            currentQR = null; // Hapus QR karena sudah terhubung
            console.log('WA Bot Terhubung!');
        }
    });
}

app.listen(PORT, () => {
    console.log('🤖 WhatsApp Bot API berjalan di port ' + PORT);
    connectToWhatsApp();
});
