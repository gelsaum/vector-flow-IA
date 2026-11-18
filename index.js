require('dotenv').config();
const telegramAlert = require('./services/telegramAlert');
const whatsapp = require('./services/whatsappService');
const apiService = require('./services/apiService');
const webService = require('./services/webService');
const sessionService = require('./services/sessionService');
const flowController = require('./controllers/flowController');
const reminderService = require('./services/reminderService');

process.on('unhandledRejection', (reason) => {
    console.error('🚫 Alerta: Promessa não tratada caindo na aplicação:', reason);
    telegramAlert.send('ERRO FATAL', `Promessa não tratada: ${reason}`);
});

process.on('uncaughtException', async (err) => {
    console.error('🚫 Erro fatal no sistema central:', err);
    try {
        await telegramAlert.send('ERRO FATAL', `Exceção não capturada: ${err.message}`);
    } finally {
        process.exit(1);
    }
});

(async () => {
    console.log('Iniciando sistema VectorFlow (Multimodal AI Architecture)...');

    try {
        await sessionService.init();
        webService.init();
        await apiService.init();
        await reminderService.init();

        console.log('✅ Webhook WebService + Urutau API + SQLite + Lembretes Conectados.');

        whatsapp.start(flowController.handleMessage.bind(flowController));
    } catch (e) {
        console.error('Fallo crítico al inicializar módulos:', e);
        process.exit(1);
    }
})();
