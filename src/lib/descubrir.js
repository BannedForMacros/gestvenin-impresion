/**
 * Encuentra las impresoras del local, RÁPIDO, por tres canales A LA VEZ.
 *
 * Lo que hace que se sienta instantáneo no es ningún canal en particular,
 * sino no depender de uno solo: cada canal va reportando lo suyo según lo
 * encuentra (callback `alEncontrar`), y la pantalla se va llenando en vivo
 * en vez de esperar a que termine el más lento.
 *
 *  1. SPOOLER de Windows (Get-Printer): las USB y todo lo ya instalado.
 *     Inmediato.
 *  2. mDNS/Bonjour: las de red que se anuncian solas. Inmediato.
 *  3. BARRIDO del puerto 9100 en la subred propia: las de red mudas, que
 *     son la mayoría de las térmicas chinas. ~1-2 s en una red de local.
 *
 * La IDENTIDAD de cada impresora (para no duplicarla en cada búsqueda) es la
 * MAC en las de red —sacada de la tabla ARP justo después de conectar— y el
 * nombre de spooler en las USB.
 */
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');

// ── 1) Spooler de Windows ─────────────────────────────────────────────

function descubrirSpooler(alEncontrar) {
    return new Promise((resolve) => {
        if (os.platform() !== 'win32') return resolve([]);

        execFile(
            'powershell.exe',
            ['-NoProfile', '-Command',
                'Get-Printer | Select-Object Name,PortName,DriverName | ConvertTo-Json -Compress'],
            { timeout: 10000, windowsHide: true },
            (err, stdout) => {
                if (err || !stdout.trim()) return resolve([]);

                let lista;
                try {
                    lista = JSON.parse(stdout);
                    if (!Array.isArray(lista)) lista = [lista];
                } catch { return resolve([]); }

                const halladas = [];
                for (const p of lista) {
                    // Los "PDF", "XPS" y "OneNote" no imprimen papel.
                    if (/PDF|XPS|OneNote|Fax/i.test(p.Name || '')) continue;

                    // Si el puerto es una IP, en realidad es una impresora de
                    // red instalada en Windows: mejor hablarle directo al
                    // 9100 (más rápido y sin driver de por medio).
                    const ip = String(p.PortName || '').match(/^(\d{1,3}\.){3}\d{1,3}/)?.[0];

                    const imp = ip
                        ? { nombre: p.Name, conexion: 'red', host: ip, puerto: 9100,
                            spooler_nombre: p.Name, identidad: 'ip:' + ip }
                        : { nombre: p.Name, conexion: 'usb', host: null, puerto: null,
                            spooler_nombre: p.Name, identidad: 'spooler:' + p.Name };

                    halladas.push(imp);
                    alEncontrar?.(imp);
                }
                resolve(halladas);
            },
        );
    });
}

// ── 2) mDNS / Bonjour ─────────────────────────────────────────────────

function descubrirMdns(alEncontrar, duracionMs = 2500) {
    return new Promise((resolve) => {
        let Bonjour;
        try { ({ Bonjour } = require('bonjour-service')); } catch { return resolve([]); }

        const bonjour = new Bonjour();
        const halladas = [];
        const vistos = new Set();

        // Los dos servicios con los que se anuncian las impresoras RAW.
        for (const tipo of ['pdl-datastream', 'printer']) {
            bonjour.find({ type: tipo }, (svc) => {
                const host = svc.addresses?.find((a) => /^\d/.test(a));
                if (!host || vistos.has(host)) return;
                vistos.add(host);

                const imp = {
                    nombre: svc.name || `Impresora ${host}`,
                    conexion: 'red',
                    host,
                    puerto: svc.port || 9100,
                    spooler_nombre: null,
                    identidad: 'ip:' + host,
                };
                halladas.push(imp);
                alEncontrar?.(imp);
            });
        }

        setTimeout(() => { try { bonjour.destroy(); } catch {} resolve(halladas); }, duracionMs);
    });
}

// ── 3) Barrido del puerto 9100 ────────────────────────────────────────

function subredesPropias() {
    const redes = [];
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const i of ifaces || []) {
            // Solo IPv4 privadas: jamás barrer nada fuera del local.
            if (i.family !== 'IPv4' || i.internal) continue;
            if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) continue;
            redes.push(i.address.split('.').slice(0, 3).join('.'));
        }
    }
    return [...new Set(redes)];
}

function probarPuerto(host, puerto, timeoutMs) {
    return new Promise((resolve) => {
        const s = new net.Socket();
        const fin = (ok) => { s.destroy(); resolve(ok); };
        s.setTimeout(timeoutMs, () => fin(false));
        s.once('error', () => fin(false));
        s.connect(puerto, host, () => fin(true));
    });
}

/** La MAC de una IP, leída de la tabla ARP (ya poblada por la conexión previa). */
function macDe(ip) {
    return new Promise((resolve) => {
        execFile('arp', ['-a', ip], { timeout: 3000, windowsHide: true }, (err, stdout) => {
            const m = String(stdout || '').match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
            resolve(m ? m[0].toLowerCase().replace(/-/g, ':') : null);
        });
    });
}

async function barrer9100(alEncontrar, { timeoutMs = 300, concurrencia = 64 } = {}) {
    const halladas = [];

    for (const base of subredesPropias()) {
        const candidatas = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);

        // 64 conexiones a la vez, 300 ms cada una: una /24 entera en ~1.2 s.
        for (let i = 0; i < candidatas.length; i += concurrencia) {
            const lote = candidatas.slice(i, i + concurrencia);
            const abiertos = await Promise.all(lote.map((ip) => probarPuerto(ip, 9100, timeoutMs)));

            for (let j = 0; j < lote.length; j++) {
                if (!abiertos[j]) continue;
                const ip = lote[j];
                const mac = await macDe(ip);
                const imp = {
                    nombre: `Impresora de red ${ip}`,
                    conexion: 'red',
                    host: ip,
                    puerto: 9100,
                    spooler_nombre: null,
                    identidad: mac ? 'mac:' + mac : 'ip:' + ip,
                };
                halladas.push(imp);
                alEncontrar?.(imp);
            }
        }
    }

    return halladas;
}

/**
 * Los tres canales en paralelo. `alEncontrar(imp)` se dispara según van
 * apareciendo; el resultado final llega deduplicado por identidad.
 */
async function descubrir(alEncontrar) {
    const vistos = new Map();

    const filtrar = (imp) => {
        // La misma impresora suele aparecer por dos canales (spooler + red).
        // Gana la primera; si la nueva trae MAC y la vieja solo IP, se
        // mejora la identidad.
        const clave = imp.host ? 'h:' + imp.host : imp.identidad;
        if (vistos.has(clave)) return;
        vistos.set(clave, imp);
        alEncontrar?.(imp);
    };

    await Promise.all([
        descubrirSpooler(filtrar),
        descubrirMdns(filtrar),
        barrer9100(filtrar),
    ]);

    return [...vistos.values()];
}

module.exports = { descubrir, descubrirSpooler, descubrirMdns, barrer9100 };
