const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

let whitelist = [];
const messageLogs = []; // Array untuk menyimpan log pengiriman

function addLog(status, to, messageStr) {
    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    messageLogs.unshift({ timestamp, status, to, message: messageStr });
    if (messageLogs.length > 50) messageLogs.pop(); // Batasi hanya 50 log terbaru
}
const WHITELIST_FILE = path.join(__dirname, 'whitelist.json');
try {
    if (fs.existsSync(WHITELIST_FILE)) {
        whitelist = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf-8'));
    } else {
        fs.writeFileSync(WHITELIST_FILE, '[]');
    }
} catch (e) {
    console.error('Failed to load whitelist:', e);
}

function saveWhitelist() {
    try {
        fs.writeFileSync(WHITELIST_FILE, JSON.stringify(whitelist, null, 2));
    } catch (e) {
        console.error('Failed to write whitelist.json:', e);
    }
}

function addToWhitelist(number) {
    let formatted = number.replace(/\D/g, '');
    if (formatted.startsWith('0')) formatted = '62' + formatted.substring(1);
    if (!whitelist.includes(formatted)) {
        whitelist.push(formatted);
        saveWhitelist();
    }
}

// Otomatis masukkan owner ke whitelist
if (process.env.OWNER_WA_NUMBER) {
    addToWhitelist(process.env.OWNER_WA_NUMBER);
}

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

routes.get('/logs', (req, res) => {
    let html = '<h2 style="font-family:sans-serif;">Log Pengiriman Bot WA (50 Terakhir)</h2>';
    html += '<table border="1" cellpadding="8" style="border-collapse: collapse; font-family:sans-serif; width:100%;">';
    html += '<tr style="background:#f0f0f0;"><th>Waktu</th><th>Status</th><th>Tujuan</th><th>Pesan</th></tr>';
    
    if (messageLogs.length === 0) {
        html += '<tr><td colspan="4" style="text-align:center;">Belum ada log aktivitas.</td></tr>';
    } else {
        messageLogs.forEach(log => {
            const color = log.status === 'SUCCESS' ? 'green' : log.status === 'ERROR' ? 'red' : 'orange';
            html += `<tr>
                <td style="white-space:nowrap;">${log.timestamp}</td>
                <td style="color:${color}; font-weight:bold;">${log.status}</td>
                <td style="white-space:nowrap;">${log.to}</td>
                <td><pre style="margin:0; white-space:pre-wrap; font-size:12px; font-family:monospace;">${log.message}</pre></td>
            </tr>`;
        });
    }
    html += '</table>';
    html += '<p style="font-family:sans-serif; margin-top:20px;"><a href="/qr">Lihat Status Bot</a> | <a href="/logs">Refresh Logs</a></p>';
    res.send(html);
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
        
        // Sistem Whitelist dinonaktifkan sementara karena isu cPanel sleep (Bot telat menerima DM saat tertidur)
        if (!req.body.isOwner && !whitelist.includes(formattedNumber)) {
            console.warn(`[Warning] Mengirim ke ${formattedNumber} yang belum DM bot (cPanel Sleep issue).`);
            addLog('WARNING (No DM)', formattedNumber, message);
        }
        
        const jid = formattedNumber + '@s.whatsapp.net';

        await sock.sendMessage(jid, { text: message });

        addLog('SUCCESS', formattedNumber, message);
        res.json({ success: true, message: 'Pesan berhasil dikirim ke ' + formattedNumber });
    } catch (error) {
        console.error('Send message error:', error);
        addLog('ERROR', req.body.number, String(error));
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

    // Tangkap pesan masuk dan catat nomor pengirim ke whitelist
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.key.remoteJid && !msg.key.remoteJid.includes('@g.us')) {
            const senderNumber = msg.key.remoteJid.split('@')[0];
            addToWhitelist(senderNumber);
            console.log(`[Whitelist] Nomor ${senderNumber} berhasil ditambahkan ke whitelist.`);
        }
    });

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
