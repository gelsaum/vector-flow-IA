const { format, parse, isValid } = require('date-fns');
require('dotenv').config();
const telegramAlert = require('./telegramAlert');
const { getAsuncionDateTimeParts, formatUrutauPhone } = require('./phoneUtils');

const CACHE_TTL_MS = 30 * 60 * 1000;

class ApiService {
    constructor() {
        this.tenantId = null;
        this.branchId = null;
        this.headers = { 'Content-Type': 'application/json' };
        this.TIMEOUT_MS = 10000;
        this._servicesCache = { data: null, expiresAt: 0 };
        this._configCache = { data: null, expiresAt: 0 };
        this._employeesCache = { data: null, expiresAt: 0 };
    }

    _getBaseUrl() {
        return (process.env.URUTAU_API_URL || 'https://studioferreira.codeart.com.py/api/v1').replace(/\/$/, '');
    }

    _getApiKey() {
        return process.env.URUTAU_API_KEY || null;
    }

    _parsePositiveInt(value) {
        const n = Number(value);
        return Number.isInteger(n) && n > 0 ? n : null;
    }

    _getHeaders(extra = {}) {
        const headers = { 'Content-Type': 'application/json' };
        const key = this._getApiKey();
        if (key) headers['X-Tenant-Key'] = key;
        const tenantId = this.tenantId || this.headers['X-Tenant-ID'];
        const branchId = this.branchId || this.headers['X-Branch-ID'];
        if (tenantId) headers['X-Tenant-ID'] = String(tenantId);
        if (branchId) headers['X-Branch-ID'] = String(branchId);
        return { ...headers, ...extra };
    }

    _normalizeDateToApi(dateStr) {
        if (!dateStr) return null;
        const clean = String(dateStr).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
            const parsedIso = parse(clean, 'yyyy-MM-dd', new Date());
            return isValid(parsedIso) ? { apiDate: clean, parsedDate: parsedIso } : null;
        }
        const parsedBr = parse(clean, 'dd/MM/yyyy', new Date());
        if (isValid(parsedBr)) {
            return { apiDate: format(parsedBr, 'yyyy-MM-dd'), parsedDate: parsedBr };
        }
        return null;
    }

    async _fetchWithTimeout(url, options = {}) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
        try {
            const response = await fetch(url, {
                ...options,
                headers: this._getHeaders(options.headers || {}),
                signal: controller.signal
            });
            clearTimeout(id);
            if (!response.ok) {
                const text = await response.text();
                const err = new Error(`Erro HTTP ${response.status}: ${text}`);
                err.status = response.status;
                err.body = text;
                throw err;
            }
            return await response.json();
        } catch (error) {
            clearTimeout(id);
            if (error.name === 'AbortError') {
                const timeoutErr = new Error(`Timeout da API após ${this.TIMEOUT_MS}ms`);
                telegramAlert.send('ERRO API URUTAU', `Timeout ao consultar ${url}`);
                throw timeoutErr;
            }
            if (error.status >= 500) {
                telegramAlert.send('ERRO API URUTAU', `HTTP ${error.status} em ${url}: ${String(error.body || '').slice(0, 250)}`);
            }
            throw error;
        }
    }

    async init() {
        const apiKey = this._getApiKey();
        if (!apiKey) {
            console.error('[ApiService] ERRO: URUTAU_API_KEY não definida no arquivo .env');
            return;
        }
        try {
            console.log('[ApiService] Inicializando conexão com Urutau API...');
            const data = await this._fetchWithTimeout(`${this._getBaseUrl()}/info`);

            if (data.success) {
                this.tenantId = data.data.tenant_id;
                this.headers['X-Tenant-ID'] = this.tenantId;
                const sucursales = data.data.sucursales;
                console.log(`[ApiService] Tenant ID conectado: ${this.tenantId}`);

                if (sucursales && sucursales.length > 0) {
                    const mainBranch = sucursales.find((s) => s.is_principal) || sucursales[0];
                    this.branchId = mainBranch.id;
                    this.headers['X-Branch-ID'] = String(this.branchId);
                    console.log(`[ApiService] Branch ID configurado: ${this.branchId} (${mainBranch.nombre})`);
                } else {
                    console.warn('[ApiService] AVISO: Nenhuma sucursal disponível para esta API Key.');
                }
            } else {
                console.error('[ApiService] ERRO na inicialização:', data.error);
                throw new Error('Init API Error: ' + data.error);
            }
        } catch (error) {
            console.error('[ApiService] Erro crítico de rede ao iniciar conexão com a API:', error.message);
        }
    }

    async obtenerConfiguracionSucursal(forceRefresh = false) {
        if (!forceRefresh && this._configCache.data && Date.now() < this._configCache.expiresAt) {
            return this._configCache.data;
        }
        if (!this.branchId) await this.init();
        if (!this.branchId) return null;
        try {
            const jsonData = await this._fetchWithTimeout(`${this._getBaseUrl()}/sucursal/configuracion`);
            if (jsonData.success && jsonData.data) {
                this._configCache = { data: jsonData.data, expiresAt: Date.now() + CACHE_TTL_MS };
                return jsonData.data;
            }
            return null;
        } catch (error) {
            console.error('[ApiService] Erro ao obter configuração da sucursal:', error.message);
            return null;
        }
    }

    async listarProfissionaisDisponiveis(dateStr, forceRefresh = false) {
        if (!forceRefresh && this._employeesCache.data && Date.now() < this._employeesCache.expiresAt) {
            return this._employeesCache.data;
        }
        if (!this.branchId) await this.init();
        const safeBranchId = this._parsePositiveInt(this.branchId);
        if (!safeBranchId) return [];
        try {
            const jsonData = await this._fetchWithTimeout(
                `${this._getBaseUrl()}/sucursales/${safeBranchId}/empleados`
            );
            if (jsonData.success && jsonData.data && jsonData.data.empleados) {
                const list = jsonData.data.empleados.map((e) => ({
                    id: e.id,
                    name: e.nombre_completo || `${e.nombres} ${e.apellidos}`
                }));
                this._employeesCache = { data: list, expiresAt: Date.now() + CACHE_TTL_MS };
                return list;
            }
            return [];
        } catch (error) {
            console.error('[ApiService] Erro ao buscar profissionais:', error.message);
            throw new Error('API_ERROR');
        }
    }

    async listarServicios(empresaId = 1, forceRefresh = false) {
        if (!forceRefresh && this._servicesCache.data && Date.now() < this._servicesCache.expiresAt) {
            return this._servicesCache.data;
        }
        if (!this.branchId) await this.init();
        const safeEmpresaId = this._parsePositiveInt(empresaId) || 1;
        try {
            const jsonData = await this._fetchWithTimeout(
                `${this._getBaseUrl()}/servicios?empresa_id=${safeEmpresaId}`
            );
            if (jsonData.success && jsonData.data && jsonData.data.servicios) {
                const list = jsonData.data.servicios.map((s) => ({
                    id: s.id,
                    nombre: s.nombre,
                    duracion: s.duracion_minutos,
                    precio: s.precio
                }));
                this._servicesCache = { data: list, expiresAt: Date.now() + CACHE_TTL_MS };
                return list;
            }
            return [];
        } catch (error) {
            console.error('[ApiService] Erro ao buscar serviços:', error.message);
            return [];
        }
    }

    async getAvailableSlots(dateStr, employeeId, servicioId = null) {
        if (!this.branchId) await this.init();
        if (!this.branchId) return [];

        const normalized = this._normalizeDateToApi(dateStr);
        const safeEmpId = this._parsePositiveInt(employeeId);
        const resolvedServiceId = this._parsePositiveInt(servicioId || process.env.DEFAULT_SERVICIO_ID || 1);
        if (!normalized || !safeEmpId || !resolvedServiceId) return [];

        const { apiDate } = normalized;
        const asuncionNow = getAsuncionDateTimeParts();

        try {
            const params = new URLSearchParams({
                profesional_id: String(safeEmpId),
                servicio_id: String(resolvedServiceId),
                fecha_desde: apiDate,
                fecha_hasta: apiDate
            });

            const jsonData = await this._fetchWithTimeout(
                `${this._getBaseUrl()}/agenda/disponibilidad?${params}`
            );

            if (jsonData.success && jsonData.data && jsonData.data.disponibilidad && jsonData.data.disponibilidad.length > 0) {
                const daySlots = jsonData.data.disponibilidad[0].slots || [];
                const isToday = apiDate === asuncionNow.dateStr;
                const currentAsuncionMinutes = (asuncionNow.hour * 60) + asuncionNow.minute;

                const availableTimes = [];
                let lastAddedMinutes = -100;

                for (const slot of daySlots) {
                    if (!slot.disponible) continue;

                    const timeStr = slot.hora_inicio.substring(0, 5);
                    const [h, m] = timeStr.split(':').map(Number);
                    const currentSlotMinutes = (h * 60) + m;

                    if (isToday && currentSlotMinutes <= currentAsuncionMinutes) {
                        continue;
                    }

                    // Filtro de Horário de Almoço: Bloquear entre 11:31 e 13:14
                    if (currentSlotMinutes > 690 && currentSlotMinutes < 795) continue;

                    // Filtro de 40 minutos
                    if (currentSlotMinutes >= lastAddedMinutes + 40) {
                        availableTimes.push(timeStr);
                        lastAddedMinutes = currentSlotMinutes;
                    }
                }
                return availableTimes;
            }
            return [];
        } catch (error) {
            console.error('[ApiService] Erro ao buscar slots:', error.message);
            throw new Error('API_ERROR');
        }
    }

    async addAppointment(appointmentData) {
        if (!this.branchId) await this.init();
        if (!this.branchId) return { success: false, reason: 'unconfigured' };

        const normalized = this._normalizeDateToApi(appointmentData.Data);
        if (!normalized) return { success: false, reason: 'invalid_date', message: 'Data inválida' };

        const employeeId = this._parsePositiveInt(appointmentData.EmployeeId);
        const serviceId = this._parsePositiveInt(appointmentData.ServicioId || process.env.DEFAULT_SERVICIO_ID || 1);
        const rawTime = String(appointmentData.Horario || '').trim();
        if (!employeeId || !serviceId || !/^\d{2}:\d{2}(:\d{2})?$/.test(rawTime)) {
            return { success: false, reason: 'invalid_params', message: 'Parâmetros de agendamento inválidos' };
        }

        let timeoutId = null;
        try {
            const apiDate = normalized.apiDate;
            const phone = formatUrutauPhone(appointmentData.Cliente_Telefone || '');

            const cleanName = String(appointmentData.Cliente_Nome || '').replace(/[\r\n\t]+/g, ' ').trim();
            const nameParts = cleanName.split(/\s+/).filter(Boolean);
            const nombres = nameParts[0] || 'Cliente';
            const apellidos = nameParts.slice(1).join(' ') || 'Cliente';

            const nowStr = format(new Date(), 'dd/MM/yyyy HH:mm');
            const horaInicio = rawTime.length === 5 ? `${rawTime}:00` : rawTime;
            const obsClean = String(appointmentData.Observaciones || '').replace(/[\r\n\t]+/g, ' ').slice(0, 250).trim();
            const obsExtra = obsClean ? ` | ${obsClean}` : '';

            // IMPORTANTE: Nunca enviar campos opcionais com null (causa HTTP 500 no Django do Urutau)
            const payloadData = {
                cliente: {
                    nombres,
                    apellidos,
                    telefono: phone
                },
                profesional_id: employeeId,
                servicio_id: serviceId,
                fecha: apiDate,
                hora_inicio: horaInicio,
                observaciones: `Agendado via Bot IA WhatsApp | Tel: ${phone} | Em: ${nowStr}${obsExtra}`
            };

            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
            const response = await fetch(`${this._getBaseUrl()}/agenda/reserva`, {
                method: 'POST',
                headers: this._getHeaders(),
                body: JSON.stringify(payloadData),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            const responseText = await response.text();
            let jsonData = {};
            try {
                jsonData = responseText ? JSON.parse(responseText) : {};
            } catch {
                jsonData = {};
            }

            if (response.status === 409 || jsonData.error?.code === 'SLOT_ALREADY_BOOKED' || jsonData.error === 'SLOT_ALREADY_BOOKED') {
                return {
                    success: false,
                    reason: 'taken',
                    message: jsonData.error?.message || jsonData.message || 'Horario ya ocupado'
                };
            }

            if (!response.ok) {
                console.error(`❌ ERRO HTTP ${response.status} ao salvar agendamento:`, responseText.slice(0, 300));
                if (response.status >= 500) {
                    telegramAlert.send('ERRO AGENDAMENTO', `HTTP ${response.status}: ${responseText.slice(0, 200)}`);
                }
                return {
                    success: false,
                    reason: 'error',
                    message: jsonData.error?.message || `Erro HTTP ${response.status}`
                };
            }

            if (jsonData.success) {
                return {
                    success: true,
                    id_agendamento: jsonData.data?.cita_id || jsonData.data?.numero_cita,
                    numero_cita: jsonData.data?.numero_cita,
                    data: jsonData.data
                };
            }

            return { success: false, reason: 'error', message: jsonData.error?.message || 'Erro desconhecido' };
        } catch (error) {
            if (timeoutId) clearTimeout(timeoutId);
            console.error('[ApiService] Erro em addAppointment:', error.message);
            telegramAlert.send('ERRO AGENDAMENTO', `Falha ao salvar: ${error.message}`);
            return { success: false, reason: 'error', message: error.message };
        }
    }

    async listarMinhasCitas(phone) {
        if (!this.branchId) await this.init();
        if (!this.branchId) return [];
        try {
            const normPhone = formatUrutauPhone(phone);
            const params = new URLSearchParams({
                telefono: normPhone,
                estado: 'activas'
            });

            const jsonData = await this._fetchWithTimeout(
                `${this._getBaseUrl()}/agenda/reservas?${params}`
            );

            if (jsonData.success && jsonData.data && jsonData.data.citas) {
                const allAppointments = [];
                for (const cita of jsonData.data.citas) {
                    if (cita.estado === 'cancelada') continue;
                    allAppointments.push({
                        data: cita.fecha,
                        horario: cita.hora_inicio.substring(0, 5),
                        cliente_nome: `${jsonData.data.cliente?.nombres || ''} ${jsonData.data.cliente?.apellidos || ''}`.trim(),
                        funcionario_nome: cita.profesional?.nombre || 'N/A',
                        profesional_id: cita.profesional?.id || null,
                        servicio_nome: cita.servicio?.nombre || null,
                        servicio_id: cita.servicio?.id || null,
                        status: cita.estado,
                        id_agendamento: cita.cita_id,
                        cancelable: cita.cancelable
                    });
                }
                return allAppointments;
            }
            return [];
        } catch (error) {
            console.error('[ApiService] Erro ao listar citas:', error.message);
            throw new Error('API_ERROR');
        }
    }

    async getReporteDiario(fecha) {
        if (!this.branchId) await this.init();
        if (!this.branchId) return [];
        const allCitas = [];
        let page = 1;
        const maxPages = 10;

        try {
            while (page <= maxPages) {
                const params = new URLSearchParams({
                    fecha,
                    page: String(page),
                    page_size: '50'
                });
                const jsonData = await this._fetchWithTimeout(
                    `${this._getBaseUrl()}/agenda/reporte-diario?${params}`
                );
                if (!jsonData.success || !jsonData.data || !Array.isArray(jsonData.data.citas)) {
                    break;
                }
                const reportDate = jsonData.data.fecha || fecha;
                for (const cita of jsonData.data.citas) {
                    allCitas.push({ ...cita, fecha: cita.fecha || reportDate });
                }
                if (!jsonData.pagination?.has_next) {
                    break;
                }
                page++;
            }
            return allCitas;
        } catch (error) {
            console.error('[ApiService] Erro ao buscar reporte diario:', error.message);
            return allCitas;
        }
    }

    async cancelarCitaPorId(citaId, motivo = 'Cancelado pelo cliente via WhatsApp Bot') {
        const safeId = this._parsePositiveInt(citaId);
        if (!safeId) return false;
        if (!this.branchId) await this.init();
        try {
            const response = await this._fetchWithTimeout(
                `${this._getBaseUrl()}/agenda/reserva/${safeId}`,
                {
                    method: 'DELETE',
                    body: JSON.stringify({ motivo: String(motivo || '').slice(0, 200) })
                }
            );
            return Boolean(response && response.success);
        } catch (error) {
            console.error('[ApiService] Erro ao cancelar cita por ID:', error.message);
            return false;
        }
    }

    async cancelarCitaPorIdForPhone(phone, citaId, motivo = 'Cancelado pelo cliente via WhatsApp Bot') {
        const safeId = this._parsePositiveInt(citaId);
        if (!safeId) return { success: false, reason: 'invalid_id' };

        const minhasCitas = await this.listarMinhasCitas(phone);
        const owned = minhasCitas.find((c) => Number(c.id_agendamento) === safeId);
        if (!owned) {
            return { success: false, reason: 'forbidden_or_not_found' };
        }
        if (owned.cancelable === false) {
            return { success: false, reason: 'not_cancelable' };
        }

        const ok = await this.cancelarCitaPorId(safeId, motivo);
        return { success: ok, fecha: owned.data, cita_id: safeId };
    }

    async cancelarCita(phone, dateStr, timeStr) {
        try {
            const minhasCitas = await this.listarMinhasCitas(phone);
            const citaParaCancelar = minhasCitas.find(
                (c) => c.data === dateStr && c.horario === timeStr
            );

            if (!citaParaCancelar || !citaParaCancelar.id_agendamento) {
                console.error('[ApiService] Cita não encontrada para cancelar:', dateStr, timeStr);
                return false;
            }

            if (citaParaCancelar.cancelable === false) {
                console.warn('[ApiService] Cita não é cancelável:', citaParaCancelar.id_agendamento);
                return false;
            }

            return await this.cancelarCitaPorId(
                citaParaCancelar.id_agendamento,
                'Cancelado pelo cliente via WhatsApp Bot'
            );
        } catch (error) {
            console.error('[ApiService] Erro ao cancelar cita:', error.message);
            return false;
        }
    }

    async reagendarCita({
        phone,
        citaIdAntiga,
        nuevaFecha,
        nuevoHorario,
        employeeId,
        servicioId,
        clienteNome,
        observaciones
    }) {
        const safeOldId = this._parsePositiveInt(citaIdAntiga);
        if (!safeOldId) {
            return { success: false, stage: 'ownership', reason: 'invalid_id' };
        }

        // Verificar propriedade e cancelabilidade ANTES de criar nova cita
        const minhasCitas = await this.listarMinhasCitas(phone);
        const ownedOld = minhasCitas.find((c) => Number(c.id_agendamento) === safeOldId);
        if (!ownedOld) {
            return { success: false, stage: 'ownership', reason: 'forbidden_or_not_found' };
        }
        if (ownedOld.cancelable === false) {
            return { success: false, stage: 'ownership', reason: 'not_cancelable' };
        }

        const created = await this.addAppointment({
            Data: nuevaFecha,
            Horario: nuevoHorario,
            Cliente_Telefone: phone,
            Cliente_Nome: clienteNome || ownedOld.cliente_nome || 'Cliente',
            EmployeeId: employeeId,
            ServicioId: servicioId,
            Observaciones: observaciones || `Reagendamento da cita #${safeOldId}`
        });

        if (!created.success) {
            return { success: false, stage: 'create_new', ...created };
        }

        const cancelled = await this.cancelarCitaPorId(
            safeOldId,
            `Reagendado para ${nuevaFecha} ${nuevoHorario} (nova cita #${created.id_agendamento})`
        );

        return {
            success: true,
            id_agendamento: created.id_agendamento,
            old_cancelled: cancelled,
            old_fecha: ownedOld.data
        };
    }
}

module.exports = new ApiService();
