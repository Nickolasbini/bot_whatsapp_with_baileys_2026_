import 'dotenv/config';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import axios from 'axios';
import pino from 'pino';
import context from './context.js';
import { useMultiFileAuthState, makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import fs from 'fs';

const allowedSenders = [];
const chatHistory = {};
const AUTH_FOLDER = 'auth_info_baileys';

async function connectToWhatsApp() {
    const {version, isLatest} = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    console.log(`Usando WA versão ${version.join('.')}, is latest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        printQRInTerminal: false,
        markOnLine: true,
        shouldSyncHistoryMessage: () => false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Escaneie o Qr Code:');
            qrcode.generate(qr, {small: true});
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log('Conexão fechada.Tentando Reconectar');

            if (statusCode === DisconnectReason.loggedOut) {
                fs.rmSync(AUTH_FOLDER, { recursive: true, force: true })
            }

            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 3000);
            }

        } else if(connection === 'open') {
            console.log('Bot Conectado com Sucesso');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') {
            return;
        }

        const msg = messages[0];
        if (
            !msg.message || 
            (msg.key.fromMe && !allowedSenders.includes(msg.key.remoteJid))
        ) {
            return;
        }

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (!allowedSenders.includes(sender) || !text) {
            return;
        }

        try {
            const aiResponse = await getAIResponse(sender, text);

            await sock.readMessages([msg.key]);

            await sock.sendPresenceUpdate('composing', sender);
            await new Promise(resolve => setTimeout(resolve, 3000));

            await sock.sendMessage(sender, { text: aiResponse});
            console.log(`Respondido para ${sender}`);

        } catch (error) {
            console.log('Erro no envio: ', error);
        }
    });
}

async function getAIResponse(sender, userInput) {
    if (!process.env.OPENROUTER_API_KEY) return 'Erro de Configuração.';
    if (!chatHistory[sender]) chatHistory[sender] = [];

    const currentTurn = { role: 'user', content: userInput };

    try {
        const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: 'openrouter/aurora-alpha',
            messages: [
                { role: 'system', content: context },
                ...chatHistory[sender],
                currentTurn 
            ],
            max_tokens: 250
        }, {
            headers: { 
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        let botResponse = res.data.choices[0].message?.content;

        if (!botResponse || botResponse.length < 2) {
            chatHistory[sender] = []; 
            return "Desculpe, tive um problema técnico. Como posso ajudar com seu pet hoje?";
        }

        chatHistory[sender].push(currentTurn);
        chatHistory[sender].push({ role: 'assistant', content: botResponse });

        if (chatHistory[sender].length > 8) chatHistory[sender].splice(0, 2);

        return botResponse;
        
    } catch (error) {
        return 'Sistema em manutenção. Tente novamente em instantes.';
    }
}

connectToWhatsApp();