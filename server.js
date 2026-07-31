const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const express = require('express');

const app = express();
app.use(express.json());

let currentQR = '';
let isConnected = false;
let waSock = null;

const N8N_WEBHOOK_PROD = process.env.N8N_WEBHOOK_URL || 'https://huz143.app.n8n.cloud/webhook/evolution-inbound';
const N8N_WEBHOOK_TEST = 'https://huz143.app.n8n.cloud/webhook-test/evolution-inbound';

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    
    waSock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000
    });

    waSock.ev.on('creds.update', saveCreds);

    waSock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQR = await QRCode.toDataURL(qr);
            isConnected = false;
            console.log('\n--> NEW QR CODE GENERATED! Open http://localhost:3000/qr\n');
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log('Connection closed, status:', statusCode);
            
            if (statusCode === DisconnectReason.loggedOut) {
                const fs = require('fs');
                if (fs.existsSync('baileys_auth_info')) {
                    fs.rmSync('baileys_auth_info', { recursive: true, force: true });
                }
            }
            setTimeout(connectToWhatsApp, 3000);
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = '';
            console.log('\n✅ WHATSAPP IS CONNECTED & READY TO SEND UNLIMITED MESSAGES!\n');
        }
    });

    // Incoming WhatsApp Message Webhook listener
    waSock.ev.on('messages.upsert', async (m) => {
        try {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe && msg.message) {
                        const remoteJid = msg.key.remoteJid || '';
                        const sender = remoteJid.split('@')[0];
                        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                        
                        if (text) {
                            console.log(`[INCOMING MESSAGE] From ${sender} (${remoteJid}): "${text}"`);
                            
                            const payload = {
                                event: "messages.upsert",
                                sender: remoteJid, // Send full JID (supports both @s.whatsapp.net and @lid)
                                data: {
                                    key: {
                                        remoteJid: remoteJid,
                                        fromMe: false,
                                        id: msg.key.id
                                    },
                                    pushName: msg.pushName || 'Customer',
                                    message: {
                                        conversation: text
                                    }
                                }
                            };

                            const fetch = (await import('node-fetch')).default;
                            
                            fetch(N8N_WEBHOOK_PROD, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload)
                            }).catch(err => console.log('Prod Webhook error:', err.message));

                            fetch(N8N_WEBHOOK_TEST, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload)
                            }).catch(err => console.log('Test Webhook error:', err.message));
                        }
                    }
                }
            }
        } catch (err) {
            console.error('Error forwarding incoming WhatsApp message:', err);
        }
    });
}

app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`
            <div style="text-align:center; margin-top:80px; font-family:sans-serif;">
                <h1 style="color:#25D366; font-size:32px;">✅ WhatsApp Connected & Ready!</h1>
                <p style="font-size:18px;">You can close this tab now. Automatic messages will send now!</p>
            </div>
        `);
    }
    if (!currentQR) {
        return res.send(`
            <div style="text-align:center; margin-top:80px; font-family:sans-serif;">
                <h2>Generating fresh QR Code...</h2>
                <p>Page will refresh automatically in 3 seconds...</p>
                <script>setTimeout(() => location.reload(), 3000);</script>
            </div>
        `);
    }
    return res.send(`
        <div style="text-align:center; margin-top:50px; font-family:sans-serif;">
            <h1 style="color:#075e54;">Scan QR Code with WhatsApp</h1>
            <p style="font-size:18px;">Open WhatsApp ➔ Settings ➔ Linked Devices ➔ Link a Device</p>
            <img src="${currentQR}" style="width:320px; height:320px; border:4px solid #25D366; border-radius:12px; padding:10px;" />
            <br/><br/>
            <p style="color:#777;">Auto-refreshing every 3 seconds to show live connection status...</p>
            <script>setTimeout(() => location.reload(), 3000);</script>
        </div>
    `);
});

app.post('/send-message', async (req, res) => {
    try {
        if (!waSock || !isConnected) {
            return res.status(500).json({ error: 'WhatsApp is not connected yet. Please scan QR code first.' });
        }
        let { number, message } = req.body;
        if (!number || !message) {
            return res.status(400).json({ error: 'Please provide number and message' });
        }

        let jid = number.toString().trim();
        if (jid.includes('@')) {
            // Already full JID (e.g. 55770368462953@lid or 919860663661@s.whatsapp.net)
        } else if (jid.length > 13) {
            // WhatsApp LID ID
            jid = jid + '@lid';
        } else {
            // Standard Phone Number
            jid = jid.replace(/[^0-9]/g, '');
            if (!jid.startsWith('91') && jid.length === 10) {
                jid = '91' + jid;
            }
            jid = jid + '@s.whatsapp.net';
        }

        console.log(`[SENDING MESSAGE] Target JID: ${jid}`);
        await waSock.sendMessage(jid, { text: message });
        console.log(`[SUCCESS] WhatsApp Message delivered to ${jid}`);
        return res.json({ status: 'success', message: `WhatsApp Message delivered to ${jid}` });
    } catch (err) {
        console.error('[ERROR] Failed to send message:', err);
        return res.status(500).json({ error: err.message });
    }
});

connectToWhatsApp();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`WhatsApp API Server listening on port ${PORT}...`);
});
