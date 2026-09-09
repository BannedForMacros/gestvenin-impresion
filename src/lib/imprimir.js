/**
 * Manda bytes ESC/POS a una impresora, por el camino que corresponda:
 *
 * - RED: un socket TCP al puerto 9100 (RAW). Es como funcionan todas las
 *   térmicas de red y por eso el 90% de esto se pudo desarrollar y probar
 *   desde un Mac.
 *
 * - USB (Windows): a través del spooler, con un PowerShell que registra el
 *   RawPrinterHelper clásico de la documentación de Microsoft (Add-Type) y
 *   escribe los bytes CRUDOS en la cola. No hay módulo nativo de Node de por
 *   medio a propósito: los binarios nativos son lo que suele romper la
 *   compilación del instalador en CI.
 */
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function imprimirRed(host, puerto, bytes, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let listo = false;

        const fallar = (e) => { if (!listo) { listo = true; socket.destroy(); reject(e); } };

        socket.setTimeout(timeoutMs, () => fallar(new Error(`La impresora ${host}:${puerto} no respondió en ${timeoutMs / 1000}s`)));
        socket.once('error', (e) => fallar(new Error(`No se pudo conectar con ${host}:${puerto}: ${e.code || e.message}`)));

        socket.connect(puerto || 9100, host, () => {
            socket.end(bytes, () => {
                if (!listo) { listo = true; resolve(); }
            });
        });
    });
}

function imprimirSpooler(nombreSpooler, bytes) {
    return new Promise((resolve, reject) => {
        if (os.platform() !== 'win32') {
            return reject(new Error('La impresión por USB/spooler solo existe en Windows.'));
        }

        // Los bytes van por fichero temporal y no por argumento: una comanda
        // puede medir varios KB y la línea de comandos tiene límite.
        const tmp = path.join(os.tmpdir(), `gv-ticket-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
        fs.writeFileSync(tmp, bytes);

        const ps1 = path.join(__dirname, 'raw-print.ps1');

        execFile(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Printer', nombreSpooler, '-File', tmp],
            { timeout: 20000, windowsHide: true },
            (err, _stdout, stderr) => {
                fs.unlink(tmp, () => {});
                if (err) {
                    reject(new Error(`El spooler rechazó el trabajo en «${nombreSpooler}»: ${String(stderr || err.message).trim().slice(0, 300)}`));
                } else {
                    resolve();
                }
            },
        );
    });
}

/** @param {object} imp fila de configuración: {conexion, host, puerto, spooler_nombre} */
async function imprimir(imp, bytes) {
    if (imp.conexion === 'red' && imp.host) {
        return imprimirRed(imp.host, imp.puerto || 9100, bytes);
    }
    if (imp.spooler_nombre) {
        return imprimirSpooler(imp.spooler_nombre, bytes);
    }
    throw new Error(`La impresora «${imp.nombre}» no tiene ni host de red ni nombre de spooler.`);
}

module.exports = { imprimir, imprimirRed, imprimirSpooler };
