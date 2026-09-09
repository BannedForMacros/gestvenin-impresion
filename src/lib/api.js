/**
 * El cliente HTTP contra el ERP. Autentica todo con el token de impresión
 * del local (el que se copia desde Configuración → Locales).
 */
const os = require('os');

class ApiErp {
    constructor(baseUrl, token) {
        this.base = String(baseUrl || '').replace(/\/+$/, '');
        this.token = token;
    }

    async _req(metodo, ruta, cuerpo = null) {
        const url = `${this.base}${ruta}${ruta.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`;
        const res = await fetch(url, {
            method: metodo,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: cuerpo ? JSON.stringify(cuerpo) : undefined,
            signal: AbortSignal.timeout(15000),
        });

        if (res.status === 401) throw new Error('TOKEN_INVALIDO');
        if (!res.ok) throw new Error(`El ERP respondió ${res.status} en ${ruta}`);
        return res.json();
    }

    /** Reclama hasta 5 trabajos (el servidor los marca 'printing' atómicamente). */
    reclamar(destino = null) {
        return this._req('GET', '/api/impresora/trabajos' + (destino ? `?destino=${destino}` : ''));
    }

    marcarListo(id) { return this._req('PATCH', `/api/impresora/trabajos/${id}/listo`); }
    marcarError(id, mensaje) { return this._req('PATCH', `/api/impresora/trabajos/${id}/error`, { error: String(mensaje).slice(0, 500) }); }

    /** Informa lo descubierto; devuelve la configuración asignada en la web. */
    registrar(impresoras, version) {
        return this._req('POST', '/api/impresora/registrar', {
            agente_version: version,
            impresoras: impresoras.map((i) => ({
                nombre: i.nombre,
                identidad: i.identidad,
                conexion: i.conexion,
                host: i.host,
                puerto: i.puerto,
                spooler_nombre: i.spooler_nombre,
                ancho_papel: i.ancho_papel || 80,
            })),
        });
    }

    /** Señal de vida; devuelve la config vigente y el canal WebSocket. */
    latido() { return this._req('POST', '/api/impresora/latido'); }
}

module.exports = { ApiErp, hostname: () => os.hostname() };
