const MESSAGES_I18N = {
    es: {
        RATE_LIMIT: '⚠️ Estás enviando demasiados mensajes muy rápido. Por seguridad, espera unos minutos antes de continuar.',
        UNSUPPORTED_MEDIA: '⚠️ Por ahora solo puedo procesar mensajes de texto, notas de voz (audio) e imágenes/fotos.',
        AUDIO_TOO_LONG: '🎤 Para atenderte más rápido, por favor envía audios de hasta 1 minuto o escríbenos tu consulta.',
        TEXT_TOO_LONG: '✍️ Tu mensaje es muy largo. Por favor resúmelo en menos de 600 caracteres.',
        STRIKE_1: '💈 Soy el asistente virtual de *Studio Ferreira*, exclusivo para citas, horarios y consultas sobre nuestros servicios. ¿En qué horario o servicio te gustaría agendar?',
        STRIKE_2: '⚠️ Este canal atiende únicamente agendamientos y dudas de *Studio Ferreira*. Si continúas enviando mensajes fuera de tema, la atención automática será suspendida.',
        STRIKE_3_BLOCKED: '🚫 Atención automática suspendida temporalmente por uso indebido de este canal.',
        AUDIO_TRANSCRIPTION_FAILED: '🎤 No pude entender bien el audio. ¿Podrías enviarlo de nuevo más claro o escribir tu mensaje?',
        IMAGE_FAILED: '📷 No pude descargar la imagen. ¿Podrías enviarla de nuevo o describirnos lo que buscas?',
        API_ERROR: '⚠️ Tuvimos un inconveniente momentáneo con el sistema de agenda. Por favor, inténtalo de nuevo en unos minutos.',
        CANCEL_ERROR: '❌ Hubo un error al cancelar la cita. Inténtalo de nuevo.',
        FATAL_ERROR: '⚠️ Ocurrió un error temporal en nuestro sistema. Inténtalo de nuevo más tarde.',
        REMINDER_MSG: (minutes, hora, pro) =>
            `⏰ *Recordatorio de Cita — Studio Ferreira*\n\n¡Hola! Te recordamos que tienes una cita en aproximadamente ${minutes} minutos (a las *${hora}*) con *${pro}*.\n\n¿Confirmas tu asistencia?\n1. Sí, confirmo\n2. No, cancelar cita`,
        REMINDER_CONFIRMED: '✅ ¡Excelente! Te esperamos en Studio Ferreira.',
        REMINDER_CANCELLED: '✅ Entendido. Tu cita ha sido cancelada con éxito para liberar el espacio. ¡Esperamos verte pronto!',
        WAITLIST_OPEN_SLOT: (fecha, hora, pro) =>
            `🎉 *¡Buenas noticias de Studio Ferreira!*\nSe acaba de liberar un espacio el *${fecha}* a las *${hora}*${pro ? ` con *${pro}*` : ''}. ¿Te gustaría reservarlo?`
    },
    pt: {
        RATE_LIMIT: '⚠️ Você está enviando muitas mensagens muito rápido. Por segurança, aguarde alguns minutos antes de continuar.',
        UNSUPPORTED_MEDIA: '⚠️ No momento consigo processar apenas mensagens de texto, áudios de voz e fotos/imagens.',
        AUDIO_TOO_LONG: '🎤 Para agilizar seu atendimento, por favor envie áudios de até 1 minuto ou digite sua mensagem.',
        TEXT_TOO_LONG: '✍️ Sua mensagem está muito longa. Por favor resuma em menos de 600 caracteres.',
        STRIKE_1: '💈 Sou o assistente virtual do *Studio Ferreira*, exclusivo para agendamentos, horários e dúvidas sobre nossos serviços. Como posso ajudar com seu horário?',
        STRIKE_2: '⚠️ Este canal atende exclusivamente agendamentos e informações do *Studio Ferreira*. Novas mensagens fora desse tema resultarão no bloqueio automático do atendimento.',
        STRIKE_3_BLOCKED: '🚫 Atendimento automático suspenso temporariamente por uso indevido deste canal.',
        AUDIO_TRANSCRIPTION_FAILED: '🎤 Não consegui entender bem o áudio. Você pode enviar novamente ou digitar sua mensagem?',
        IMAGE_FAILED: '📷 Não consegui abrir a imagem. Pode enviar novamente ou descrever o serviço que procura?',
        API_ERROR: '⚠️ Tivemos uma instabilidade momentânea no sistema de agenda. Por favor, tente novamente em alguns instantes.',
        CANCEL_ERROR: '❌ Não foi possível cancelar este agendamento. Tente novamente.',
        FATAL_ERROR: '⚠️ Ocorreu um erro temporário no atendimento. Tente novamente em alguns instantes.',
        REMINDER_MSG: (minutes, hora, pro) =>
            `⏰ *Lembrete de Agendamento — Studio Ferreira*\n\nOlá! Lembrando que você tem um horário marcado em cerca de ${minutes} minutos (às *${hora}*) com *${pro}*.\n\nVocê confirma sua presença?\n1. Sim, confirmo\n2. Não, cancelar horário`,
        REMINDER_CONFIRMED: '✅ Perfeito! Te esperamos no Studio Ferreira.',
        REMINDER_CANCELLED: '✅ Tudo certo! Seu horário foi cancelado para liberar a vaga. Esperamos te ver em breve!',
        WAITLIST_OPEN_SLOT: (fecha, hora, pro) =>
            `🎉 *Boa notícia do Studio Ferreira!*\nAcabou de liberar um horário em *${fecha}* às *${hora}*${pro ? ` com *${pro}*` : ''}. Quer reservar essa vaga?`
    }
};

function getLocalized(lang, key, ...args) {
    const dict = MESSAGES_I18N[lang === 'pt' ? 'pt' : 'es'] || MESSAGES_I18N.es;
    const entry = dict[key];
    if (typeof entry === 'function') return entry(...args);
    return entry || '';
}

module.exports = {
    MESSAGES_I18N,
    getLocalized,
    MAIN_MENU_TEXT: `
*Menú Principal*
1. Agendar Cita/Horario
2. Ver Mis Citas/Horarios
`,
    WELCOME: '¡Hola! Bienvenido a *Studio Ferreira* ¿en qué podemos ayudarte?.\n',
    INVALID_OPTION: 'Opción inválida.\n',
    INVALID_NUM: 'Opción inválida. Digite 1 o 2.',
    API_ERROR: 'Ocurrió un error técnico al conectarnos con el sistema central. Por favor, inténtalo de nuevo más tarde.',
    FATAL_ERROR: 'Ocurrió un error temporal en nuestro sistema. Inténtalo de nuevo más tarde.',
    CANCEL_SUCCESS: '✅ Cita/horario cancelada con éxito.',
    CANCEL_ERROR: '❌ Hubo un error al cancelar. Inténtalo de nuevo.',
    INVALID_CANCEL_NUM: '⚠️ Opción inválida. Envía el número de la cita/horario a cancelar o 0 para volver.',
    NO_FUTURE_APPS: '📅 No tienes citas/horarios futuras agendadas.',
    SELECT_MANUAL_DATE: '✍️ Por favor, escribe la fecha en formato *día/mes/año* (ej: 25/12/2025):',
    NO_SUNDAY: '⚠️ Lo siento, no trabajamos los domingos. Por favor elige otra fecha.',
    NO_PAST_DATE: '⚠️ No puedes seleccionar una fecha pasada. Por favor elige una fecha futura.',
    INVALID_DATE_FMT: 'Formato inválido. Use dia/mês/ano (ex: 01/02/2026 ou 01/02/26).',
    NO_PROFS_AVAIL: '⚠️ Lo siento, no hay profesionales disponibles para esta fecha (Quizás es feriado o están todos ocupados).',
    WHAT_TO_DO: '*¿Qué deseas hacer?*\n1. Elegir otra fecha\n2. Volver al Menú Principal',
    NO_SLOTS: '⚠️ Lo siento, no hay horarios libres en esta fecha.',
    RETRY_DOC: '*¿Qué deseas hacer?*\n1. Elegir otro profesional\n2. Volver al Menú Principal',
    SLOT_TAKEN: '⚠️ ¡Vaya! Alguien acaba de reservar este exacto horario hace un momento. 😓\n\nPor favor, selecciona otro.',
    SAVE_ERROR: '❌ Error al guardar la cita/horario. Inténtalo de nuevo.',
    APP_CONFIRMED: '✅ ¡Cita/horario confirmada con éxito!',
    POST_APP_ACTIONS: '*¿Qué deseas hacer ahora?*\n1. Ver detalles de mi cita/horario\n2. Finalizar conversación',
    BYE: '¡Gracias por usar nuestro sistema! 👋',
    CONFIRM_INVALID: '⚠️ Opción inválida. Por favor responde *Sí* para confirmar o *No* para cancelar.',
    SHORT_NAME: 'Nombre muy corto. Por favor, escribe tu nombre completo.',
    ONLY_TEXT: '⚠️ Por favor, envíe solo mensajes de texto. Nuestro asistente no puede escuchar audios ni abrir archivos o imágenes.',
    REMINDER_CONFIRMED: MESSAGES_I18N.es.REMINDER_CONFIRMED,
    REMINDER_CANCELLED: MESSAGES_I18N.es.REMINDER_CANCELLED
};
