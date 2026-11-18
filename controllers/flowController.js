const sessionService = require('../services/sessionService');
const whatsapp = require('../services/whatsappService');
const apiService = require('../services/apiService');
const guardrailService = require('../services/guardrailService');
const mediaService = require('../services/mediaService');
const debounceService = require('../services/debounceService');
const aiService = require('../services/aiService');
const reminderService = require('../services/reminderService');
const msgs = require('../constants/messages');
const { getCanonicalPhone } = require('../services/phoneUtils');

function normalizeText(text) {
    if (!text) return '';
    return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

class FlowController {
    async notifyWaitlistForDate(dateStr, servicesOverrides = {}) {
        const sess = servicesOverrides.sessionService || sessionService;
        const wa = servicesOverrides.whatsapp || whatsapp;
        if (!dateStr) return 0;

        try {
            const waiting = await sess.getWaitlistForDate(dateStr);
            let notifiedCount = 0;
            for (const entry of waiting) {
                const msg = msgs.getLocalized(
                    entry.lang || 'es',
                    'WAITLIST_OPEN_SLOT',
                    dateStr,
                    entry.desired_time || '--:--',
                    null
                );
                const sent = await wa.sendText(entry.phone, msg);
                if (sent) {
                    await sess.markWaitlistNotified(entry.id);
                    notifiedCount++;
                }
            }
            return notifiedCount;
        } catch (err) {
            console.error('[FlowController] Erro ao notificar lista de espera:', err.message);
            return 0;
        }
    }

    async _safeSend(wa, to, text) {
        try {
            return await wa.sendText(to, text);
        } catch (err) {
            console.error('[FlowController] Falha ao enviar mensagem WhatsApp:', err.message);
            return null;
        }
    }

    async handleMessage(message, overrides = {}) {
        const sess = overrides.sessionService || sessionService;
        const wa = overrides.whatsapp || whatsapp;
        const api = overrides.apiService || apiService;
        const guard = overrides.guardrailService || guardrailService;
        const media = overrides.mediaService || mediaService;
        const debounce = overrides.debounceService || debounceService;
        const ai = overrides.aiService || aiService;
        const rem = overrides.reminderService || reminderService;

        if (!message || message.isGroupMsg || message.from === 'status@broadcast') return null;

        const from = message.from;
        const phone = getCanonicalPhone(message);
        if (!from || !phone) return null;

        try {
            // Handoff humano quando atendente responde direto pelo WhatsApp da loja
            if (message.isHumanAttendantReply) {
                const cmd = normalizeText(message.body);
                if (cmd === '#bot' || cmd === '/bot') {
                    await guard.releaseHumanTakeover(phone, sess);
                } else {
                    await guard.activateHumanTakeover(phone, sess);
                }
                return { status: 'human_takeover_handled' };
            }

            const customer = await sess.getCustomer(phone);
            const storedLang = customer?.preferred_lang || 'es';

            // Camada 1: Guardrail determinístico (0 tokens)
            const gate = await guard.checkIncoming(
                phone,
                {
                    body: message.body,
                    mediaType: message.mediaType,
                    mediaInfo: message.mediaInfo,
                    lang: storedLang
                },
                sess
            );

            if (!gate.allowed) {
                if (!gate.silent && gate.reply) {
                    await this._safeSend(wa, from, gate.reply);
                }
                return { status: 'blocked_or_filtered', reason: gate.reason, reply: gate.reply || null };
            }

            let detectedLang = gate.lang;
            if (gate.langConfident) {
                await sess.upsertCustomer(phone, { preferred_lang: detectedLang });
            }

            // Atalho para resposta de lembrete (chave canônica: phone)
            const session = await sess.getSession(phone);
            const bodyNorm = normalizeText(message.body);
            if (session.step === 'AWAITING_REMINDER_REPLY' && !message.mediaType) {
                if (['1', 'si', 's', 'sim', 'yes', 'confirmar', 'confirmo'].includes(bodyNorm)) {
                    const reply = msgs.getLocalized(detectedLang, 'REMINDER_CONFIRMED');
                    await this._safeSend(wa, from, reply);
                    session.step = 'START';
                    await sess.saveSession(phone, session);
                    return { status: 'reminder_confirmed', reply };
                }
                if (['2', 'no', 'nao', 'n', 'cancelar'].includes(bodyNorm)) {
                    const citaId = session.data?.cancelCitaId;
                    const res = citaId
                        ? await api.cancelarCitaPorIdForPhone(phone, citaId, 'Cancelado pelo cliente via Lembrete do Bot')
                        : { success: false };
                    const reply = res.success
                        ? msgs.getLocalized(detectedLang, 'REMINDER_CANCELLED')
                        : msgs.getLocalized(detectedLang, 'CANCEL_ERROR');
                    await this._safeSend(wa, from, reply);
                    if (res.success) {
                        rem.cancelTimer(citaId);
                        await sess.deleteReminder(citaId);
                        const freedDate = res.fecha || session.data?.cancelFecha;
                        if (freedDate) {
                            await this.notifyWaitlistForDate(freedDate, { sessionService: sess, whatsapp: wa });
                        }
                    }
                    session.step = 'START';
                    await sess.saveSession(phone, session);
                    return { status: 'reminder_cancelled', reply };
                }
            }

            // Processamento Multimodal (áudio / foto)
            let textForAi = typeof message.body === 'string' ? message.body.trim() : '';
            let audioText = '';
            let imageAnalysis = null;

            if (message.mediaType === 'audio') {
                const fetched = await media.fetchMediaBase64(message.raw, message.mediaInfo?.mimetype, from);
                const transcribed = fetched
                    ? await media.transcribeAudio(fetched.base64, fetched.mimetype, detectedLang)
                    : null;

                if (!transcribed) {
                    const failMsg = msgs.getLocalized(detectedLang, 'AUDIO_TRANSCRIPTION_FAILED');
                    await this._safeSend(wa, from, failMsg);
                    return { status: 'audio_failed', reply: failMsg };
                }

                audioText = transcribed;
                const audioLang = guard.detectLanguageWithConfidence(transcribed, detectedLang);
                detectedLang = audioLang.lang;
                if (audioLang.confident) {
                    await sess.upsertCustomer(phone, { preferred_lang: detectedLang });
                }

                if (!guard.isTextWithinLimit(transcribed)) {
                    const lenMsg = msgs.getLocalized(detectedLang, 'TEXT_TOO_LONG');
                    await this._safeSend(wa, from, lenMsg);
                    return { status: 'audio_text_too_long', reply: lenMsg };
                }

                if (guard.isPromptInjectionOrAbuse(transcribed)) {
                    const strike = await guard.registerStrike(phone, 'AUDIO_INJECTION_OR_ABUSE', transcribed, detectedLang, sess);
                    await this._safeSend(wa, from, strike.reply);
                    return { status: 'strike_audio', reply: strike.reply };
                }
            }

            if (message.mediaType === 'image') {
                const fetched = await media.fetchMediaBase64(message.raw, message.mediaInfo?.mimetype, from);
                if (!fetched && !textForAi) {
                    const imgFailMsg = msgs.getLocalized(detectedLang, 'IMAGE_FAILED');
                    await this._safeSend(wa, from, imgFailMsg);
                    return { status: 'image_failed', reply: imgFailMsg };
                }

                if (fetched) {
                    const availableServices = await api.listarServicios();
                    imageAnalysis = await media.analyzeImage(
                        fetched.base64,
                        fetched.mimetype,
                        message.mediaInfo?.caption || textForAi,
                        availableServices,
                        detectedLang
                    );

                    if (!imageAnalysis && !textForAi) {
                        const imgFailMsg = msgs.getLocalized(detectedLang, 'IMAGE_FAILED');
                        await this._safeSend(wa, from, imgFailMsg);
                        return { status: 'image_failed', reply: imgFailMsg };
                    }

                    if (imageAnalysis?.category === 'off_topic_or_inappropriate') {
                        const strike = await guard.registerStrike(
                            phone,
                            'OFF_TOPIC_IMAGE',
                            message.mediaInfo?.caption || imageAnalysis.summary || 'off-topic image',
                            detectedLang,
                            sess
                        );
                        await this._safeSend(wa, from, strike.reply);
                        return { status: 'strike_image', reply: strike.reply };
                    }
                }
            }

            // Debounce + Fila serializada por telefone + IA + Tools Urutau
            return await debounce.enqueue(
                phone,
                {
                    text: message.mediaType === 'audio' ? '' : textForAi,
                    audioText: audioText ? `[Áudio transcrito]: ${audioText}` : '',
                    image: imageAnalysis,
                    meta: {
                        from,
                        lang: detectedLang,
                        langConfident: gate.langConfident,
                        mediaType: message.mediaType || 'text'
                    }
                },
                async (batch) => {
                    const finalLang = batch.meta.lang || detectedLang;
                    try {
                        const combined = batch.combinedText || '';

                        // Re-valida pós-debounce contra ataques divididos em múltiplas mensagens curtas
                        if (combined && !guard.isTextWithinLimit(combined)) {
                            const lenMsg = msgs.getLocalized(finalLang, 'TEXT_TOO_LONG');
                            await this._safeSend(wa, from, lenMsg);
                            return { status: 'blocked_or_filtered', reason: 'TEXT_TOO_LONG_MERGED', reply: lenMsg };
                        }
                        if (combined && guard.isPromptInjectionOrAbuse(combined)) {
                            const strike = await guard.registerStrike(phone, 'SPLIT_INJECTION_OR_ABUSE', combined, finalLang, sess);
                            await this._safeSend(wa, from, strike.reply);
                            return { status: 'strike_merged', reply: strike.reply };
                        }

                        const userTurnText = combined || batch.images.map((i) => i?.summary).filter(Boolean).join(' | ');
                        if (!userTurnText) {
                            return { status: 'empty_ignored' };
                        }

                        await sess.addHistory(phone, 'user', userTurnText, batch.meta.mediaType);

                        const aiResult = await ai.processTurn({
                            phone,
                            text: userTurnText,
                            lang: finalLang,
                            imageContext: batch.images,
                            context: {
                                apiService: api,
                                sessionService: sess,
                                guardrailService: guard,
                                reminderService: rem,
                                onSlotFreed: (fecha) => this.notifyWaitlistForDate(fecha, { sessionService: sess, whatsapp: wa })
                            }
                        });

                        const replyText = aiResult?.reply || msgs.getLocalized(finalLang, 'FATAL_ERROR');
                        await sess.addHistory(phone, 'assistant', replyText, 'text');
                        await this._safeSend(wa, from, replyText);

                        return { status: 'replied', provider: aiResult?.provider, reply: replyText };
                    } catch (error) {
                        console.error('[FlowController] Erro ao processar turno IA:', error);
                        await this._safeSend(wa, from, msgs.getLocalized(finalLang, 'FATAL_ERROR'));
                        return { status: 'error', error: error.message };
                    }
                }
            );
        } catch (outerErr) {
            console.error('[FlowController] Erro inesperado em handleMessage:', outerErr);
            await this._safeSend(wa, from, msgs.getLocalized(customer?.preferred_lang || 'es', 'FATAL_ERROR'));
            return { status: 'error', error: outerErr.message };
        }
    }
}

module.exports = new FlowController();
