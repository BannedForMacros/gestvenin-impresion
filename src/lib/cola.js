/**
 * El motor del agente: REACCIONA, no pregunta.
 *
 * El diseño que pidió el dueño con todas las letras: «no andar preguntando a
 * cada rato si hay impresión». Así que:
 *
 *  - La señal principal es el WEBSOCKET (Reverb, el mismo canal en tiempo
 *    real de las alertas de delivery). El ERP toca el timbre al encolar y
 *    este motor reclama e imprime al instante. Cero tráfico mientras no
 *    haya nada.
 *
 *  - Queda UN sondeo lento (90 s) como red de seguridad: si el WebSocket se
 *    cae sin que nadie lo note, ningún ticket se queda atrapado más de
 *    minuto y medio. Es el mismo diseño push+reconciliación de las alertas
 *    del ERP.
 *
 *  - COLA EN DISCO: un trabajo reclamado se guarda en el userData ANTES de
 *    intentar imprimirlo. Si se va la luz o se cierra el programa a mitad,
 *    al volver se retoma de ahí — el ERP ya lo dio por entregado a este
 *    agente y no lo va a repetir hasta el rescate de los 5 minutos; el
 *    disco hace que ni siquiera haga falta esperar eso.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { render } = require('./escpos');
const { imprimir } = require('./imprimir');

const SONDEO_RESPALDO_MS = 90_000;
const REINTENTO_WS_MS = 10_000;

class MotorImpresion extends EventEmitter {
    /**
     * @param {ApiErp} api
     * @param {string} dirDatos  carpeta persistente (app.getPath('userData'))
     */
    constructor(api, dirDatos) {
        super();
        this.api = api;
        this.archivoCola = path.join(dirDatos, 'cola-pendiente.json');
        this.impresoras = [];        // configuración vigente (la asigna la web)
        this.canal = null;           // nombre del canal WebSocket
        this.ws = null;
        this.wsUrl = null;
        this.corriendo = false;
        this.reclamando = false;
        this.historial = [];         // últimos 50 trabajos, para la pantalla
    }

    // ── ciclo de vida ─────────────────────────────────────────────────

    async arrancar(wsUrl) {
        this.corriendo = true;
        this.wsUrl = wsUrl;

        // Primero lo que quedó en disco de una sesión anterior.
        await this._procesarColaLocal();

        // Latido inicial: trae configuración y canal.
        await this.latir().catch(() => {});

        this._conectarWs();

        this.timerSondeo = setInterval(() => this.reclamarYProcesar('sondeo'), SONDEO_RESPALDO_MS);
        this.timerLatido = setInterval(() => this.latir().catch(() => {}), 60_000);

        // Barrido inicial por si había algo esperando de antes.
        this.reclamarYProcesar('arranque');
    }

    parar() {
        this.corriendo = false;
        clearInterval(this.timerSondeo);
        clearInterval(this.timerLatido);
        try { this.ws?.close(); } catch {}
    }

    async latir() {
        const r = await this.api.latido();
        this.impresoras = r.impresoras || [];
        if (r.canal && r.canal !== this.canal) {
            this.canal = r.canal;
            this._resuscribir();
        }
        this.emit('estado', this.resumen());
        return r;
    }

    // ── WebSocket (protocolo pusher, que es lo que habla Reverb) ──────

    _conectarWs() {
        if (!this.corriendo || !this.wsUrl) return;

        try { this.ws?.terminate(); } catch {}

        const ws = new WebSocket(this.wsUrl);
        this.ws = ws;

        ws.on('open', () => { this.emit('ws', true); this._resuscribir(); });

        ws.on('message', (crudo) => {
            let msg;
            try { msg = JSON.parse(crudo.toString()); } catch { return; }

            // El ping del protocolo hay que devolverlo o el servidor corta.
            if (msg.event === 'pusher:ping') {
                ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
                return;
            }

            // El timbre: hay trabajo. Se reclama al instante.
            if (msg.event === 'trabajo.encolado') {
                this.reclamarYProcesar('timbre');
            }
        });

        const caida = () => {
            this.emit('ws', false);
            if (this.corriendo) setTimeout(() => this._conectarWs(), REINTENTO_WS_MS);
        };
        ws.on('close', caida);
        ws.on('error', () => { /* close llega después y reintenta */ });
    }

    _resuscribir() {
        if (this.canal && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                event: 'pusher:subscribe',
                data: { channel: this.canal },
            }));
        }
    }

    // ── reclamo e impresión ───────────────────────────────────────────

    async reclamarYProcesar(origen) {
        // Sin candado, un timbre y un sondeo simultáneos reclamarían en
        // paralelo. No duplicaría (el servidor es atómico) pero desordenaría.
        if (this.reclamando || !this.corriendo) return;
        this.reclamando = true;

        try {
            let vuelta = 0;
            // Se repite hasta vaciar: el servidor entrega de a 5.
            while (this.corriendo && vuelta++ < 20) {
                const { trabajos } = await this.api.reclamar();
                if (!trabajos?.length) break;

                this._guardarEnDisco(trabajos);
                await this._procesarColaLocal();
            }
        } catch (e) {
            this.emit('error-red', e.message);
        } finally {
            this.reclamando = false;
        }
    }

    _leerDisco() {
        try { return JSON.parse(fs.readFileSync(this.archivoCola, 'utf8')); } catch { return []; }
    }

    _guardarEnDisco(nuevos) {
        const cola = this._leerDisco();
        const ids = new Set(cola.map((t) => t.id));
        for (const t of nuevos) if (!ids.has(t.id)) cola.push(t);
        fs.writeFileSync(this.archivoCola, JSON.stringify(cola));
    }

    async _procesarColaLocal() {
        let cola = this._leerDisco();

        while (cola.length && this.corriendo) {
            const trabajo = cola[0];

            // Nada cableado: el destino es el texto que el dueño configuró
            // en el ERP («caja», «cocina», «segundo-piso»...). Un trabajo
            // SIN destino sale por cualquier impresora asignada; con
            // destino, por la que coincida exacto, y si esa no existe se
            // cae a cualquiera antes que no imprimir.
            const destino = trabajo.destino || null;

            const imp = (destino && this.impresoras.find((i) => i.destino === destino))
                ?? this.impresoras.find((i) => i.destino)
                ?? this.impresoras[0];

            if (!imp) {
                // Sin impresoras configuradas no hay nada que hacer: se deja
                // el trabajo en disco y se avisa a la pantalla. El próximo
                // latido puede traer configuración nueva.
                this.emit('sin-impresora', trabajo);
                return;
            }

            try {
                const bytes = render(trabajo.payload, imp.ancho_papel || 80);
                await imprimir(imp, bytes);
                await this.api.marcarListo(trabajo.id).catch(() => {
                    // Si la confirmación no llega, el rescate del servidor lo
                    // reencolará y podría salir dos veces. Preferible un
                    // ticket repetido que uno perdido: en papel, el duplicado
                    // se tira; el que falta es una comanda que nunca se cocinó.
                });
                this._anotar(trabajo, imp, 'impreso', null);
            } catch (e) {
                await this.api.marcarError(trabajo.id, e.message).catch(() => {});
                this._anotar(trabajo, imp, 'fallo', e.message);
            }

            // Impreso o fallado, sale de la cola local: el reintento de los
            // fallos lo gobierna el SERVIDOR (rescate + intentos), no este
            // disco — dos lógicas de reintento se pisarían.
            cola.shift();
            fs.writeFileSync(this.archivoCola, JSON.stringify(cola));
        }
    }

    _anotar(trabajo, imp, resultado, error) {
        this.historial.unshift({
            id: trabajo.id,
            tipo: trabajo.payload?.tipo || 'ticket',
            destino: trabajo.destino,
            impresora: imp?.nombre,
            resultado,
            error,
            hora: new Date().toLocaleTimeString('es-PE'),
            // El payload entero se conserva para poder REIMPRIMIR desde la
            // pantalla: el ERP ya dio este trabajo por entregado y no lo va
            // a volver a servir.
            payloadCompleto: trabajo.payload,
        });
        this.historial = this.historial.slice(0, 50);
        this.emit('trabajo', this.historial[0]);
    }

    resumen() {
        return {
            impresoras: this.impresoras,
            canal: this.canal,
            wsConectado: this.ws?.readyState === WebSocket.OPEN,
            pendientesLocal: this._leerDisco().length,
            historial: this.historial,
        };
    }
}

module.exports = { MotorImpresion };
