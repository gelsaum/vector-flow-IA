const express = require('express');
const http = require('http');
const crypto = require('crypto');

class WebService {
    constructor() {
        this.app = express();
        this.app.disable('x-powered-by');

        const bodyLimit = process.env.WEBHOOK_BODY_LIMIT || '10mb';
        this.app.use(express.json({ limit: bodyLimit }));
        this.app.use(express.urlencoded({ limit: bodyLimit, extended: true }));

        this.server = http.createServer(this.app);
        this.port = Number(process.env.PORT || 3000);
        this.host = process.env.HOST || '127.0.0.1';

        this.setupRoutes();
    }

    verifyWebhookAuth(req) {
        const expected = process.env.WEBHOOK_SECRET;
        if (!expected) {
            return false;
        }
        const provided = String(req.get('x-webhook-secret') || req.get('apikey') || '');
        const a = Buffer.from(provided, 'utf8');
        const b = Buffer.from(String(expected), 'utf8');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    setupRoutes() {
        this.app.get('/', (req, res) => {
            res.send('Bot Activo y escuchando webhooks para Evolution API.');
        });

        this.app.post('/webhook', (req, res) => {
            if (!this.verifyWebhookAuth(req)) {
                return res.status(401).send('Unauthorized');
            }

            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                return res.status(400).send('Invalid payload');
            }

            // Respondemos rápido para evitar timeouts en Evolution API
            res.status(200).send('OK');

            const event = req.body.event || req.body.type || 'desconhecido';
            let sender = req.body.data?.key?.remoteJid || '';
            if (!sender && Array.isArray(req.body.data) && req.body.data[0]?.key?.remoteJid) {
                sender = req.body.data[0].key.remoteJid;
            } else if (!sender && req.body.data?.messages?.[0]?.key?.remoteJid) {
                sender = req.body.data.messages[0].key.remoteJid;
            }

            console.log('==================================');
            console.log(`📥 WEBHOOK RECEBIDO: ${event} | Remetente: ${sender || 'N/A'}`);
            console.log('==================================\n');

            try {
                const whatsapp = require('./whatsappService');
                whatsapp.handleEvolutionWebhook(req.body);
            } catch (error) {
                console.error('Error procesando webhook:', error);
            }
        });
    }

    init() {
        this.server.on('error', (e) => {
            if (e.code === 'EADDRINUSE') {
                if (process.env.NODE_ENV === 'production') {
                    console.error(`Erro fatal: Porta ${this.port} já está em uso.`);
                    process.exit(1);
                }
                console.log(`Porta ${this.port} em uso, tentando próxima...`);
                this.port++;
                this.server.listen(this.port, this.host);
            } else {
                console.error('Erro no servidor web:', e);
            }
        });

        this.server.listen(this.port, this.host, async () => {
            console.log(`🚀 Servidor Web iniciado em http://${this.host}:${this.port}`);

            const ngrokUrl = await this.getNgrokUrl();
            if (ngrokUrl) {
                console.log('===================================================');
                console.log('🌍 🎉 PUBLIC WEBHOOK URL (Configura esto en Evolution):');
                console.log(`    ${ngrokUrl}/webhook`);
                console.log('===================================================');
            } else {
                console.log('===================================================');
                console.log('👉 No se detectó ngrok.');
                console.log('Si configuras en un VPS, usa tu proxy HTTPS reverso hacia:');
                console.log(`    http://${this.host}:${this.port}/webhook`);
                console.log('===================================================');
            }
        });
    }

    getNgrokUrl() {
        return new Promise((resolve) => {
            const req = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const tunnel = json.tunnels.find((t) => t.proto === 'https');
                        resolve(tunnel ? tunnel.public_url : null);
                    } catch {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(2000, () => {
                req.destroy();
                resolve(null);
            });
        });
    }
}

module.exports = new WebService();
