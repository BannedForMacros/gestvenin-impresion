/**
 * GestVenin Impresión — proceso principal.
 *
 * Un agente de bandeja: arranca con Windows, vive junto al reloj, y solo
 * abre ventana cuando alguien quiere ver el estado o configurar. El trabajo
 * de verdad (escuchar el timbre del ERP e imprimir) lo hace el
 * MotorImpresion sin interfaz de por medio.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { ApiErp } = require('./lib/api');
const { MotorImpresion } = require('./lib/cola');
const { descubrir } = require('./lib/descubrir');
const { render, prueba } = require('./lib/escpos');
const { imprimir } = require('./lib/imprimir');

const URL_ERP = 'https://gestvenin.com';

let ventana = null;
let tray = null;
let motor = null;
let api = null;

// ── configuración persistente (token del local) ───────────────────────

const archivoConfig = () => path.join(app.getPath('userData'), 'config.json');

function leerConfig() {
    try { return JSON.parse(fs.readFileSync(archivoConfig(), 'utf8')); } catch { return {}; }
}

function guardarConfig(cambios) {
    const cfg = { ...leerConfig(), ...cambios };
    fs.writeFileSync(archivoConfig(), JSON.stringify(cfg, null, 2));
    return cfg;
}

// ── ventana y bandeja ─────────────────────────────────────────────────

function abrirVentana() {
    if (ventana) { ventana.show(); ventana.focus(); return; }

    ventana = new BrowserWindow({
        width: 760,
        height: 640,
        title: 'GestVenin Impresión',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    ventana.loadFile(path.join(__dirname, 'ui', 'index.html'));

    // Cerrar la ventana NO cierra el agente: se esconde y sigue imprimiendo.
    ventana.on('close', (e) => {
        if (!app.saliendo) { e.preventDefault(); ventana.hide(); }
    });
    ventana.on('closed', () => { ventana = null; });
}

function crearTray() {
    // Ícono mínimo dibujado al vuelo: sin assets binarios en el repo.
    const icono = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVQ4y2NgGAWDHzAyMPxnYGBgYmBg+I+E/6PxsRqAbAg2zSgGYDMEmyFYDcBmCDZDcBqAzRB0Q/AagM0QdEPwGoDNEHRDCBqAzRBkQ4gyAJshMEOINmAUDCwAAJHfJcE0Cyk3AAAAAElFTkSuQmCC',
    );
    tray = new Tray(icono);
    tray.setToolTip('GestVenin Impresión');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Abrir', click: abrirVentana },
        { type: 'separator' },
        { label: 'Salir', click: () => { app.saliendo = true; motor?.parar(); app.quit(); } },
    ]));
    tray.on('double-click', abrirVentana);
}

// ── el motor ──────────────────────────────────────────────────────────

async function arrancarMotor() {
    const cfg = leerConfig();
    if (!cfg.token) return; // sin token todavía: el asistente lo pedirá

    api = new ApiErp(cfg.urlErp || URL_ERP, cfg.token);
    motor = new MotorImpresion(api, app.getPath('userData'));

    const reenviar = (canal) => (dato) => ventana?.webContents.send(canal, dato);
    motor.on('estado', reenviar('motor:estado'));
    motor.on('trabajo', reenviar('motor:trabajo'));
    motor.on('ws', reenviar('motor:ws'));
    motor.on('error-red', reenviar('motor:error-red'));
    motor.on('sin-impresora', reenviar('motor:sin-impresora'));

    // La URL del WebSocket la da el propio ERP en el latido: nada cableado.
    try {
        const r = await motor.latir();
        await motor.arrancar(r.ws_url);
    } catch (e) {
        // Sin red al arrancar: reintentar en un minuto, sin morir.
        setTimeout(arrancarMotor, 60_000);
    }
}

// ── IPC con la interfaz ───────────────────────────────────────────────

ipcMain.handle('config:leer', () => leerConfig());

ipcMain.handle('config:guardarToken', async (_e, { token, urlErp }) => {
    // Se valida ANTES de guardar: un token mal pegado se descubre aquí, no
    // mañana cuando no salga ninguna comanda.
    const apiPrueba = new ApiErp(urlErp || URL_ERP, token);
    await apiPrueba.latido(); // lanza TOKEN_INVALIDO si no vale

    guardarConfig({ token, urlErp: urlErp || URL_ERP });
    motor?.parar();
    await arrancarMotor();
    return { ok: true };
});

ipcMain.handle('descubrir', async (e) => {
    const halladas = await descubrir((imp) => e.sender.send('descubrir:hallada', imp));
    // Lo hallado se registra en el ERP para que el dueño asigne destinos.
    if (api) {
        try {
            const r = await api.registrar(halladas, app.getVersion());
            motor && (motor.impresoras = r.impresoras || []);
        } catch { /* sin red: se reintentará en el próximo latido */ }
    }
    return halladas;
});

ipcMain.handle('probarImpresora', async (_e, imp) => {
    await imprimir(imp, prueba(imp.nombre, imp.ancho_papel || 80));
    return { ok: true };
});

ipcMain.handle('motor:resumen', () => motor?.resumen() ?? null);

ipcMain.handle('reimprimir', async (_e, entrada) => {
    // Reimprime desde el historial local (el payload ya no está en el ERP
    // como pendiente). Busca la impresora del mismo destino.
    const imp = motor?.impresoras.find((i) => i.destino === entrada.destino) ?? motor?.impresoras[0];
    if (!imp) throw new Error('No hay impresora configurada.');
    const trabajoOriginal = motor?.historial.find((h) => h.id === entrada.id);
    if (!trabajoOriginal?.payloadCompleto) throw new Error('Ese trabajo ya no está en memoria.');
    await imprimir(imp, render(trabajoOriginal.payloadCompleto, imp.ancho_papel || 80));
    return { ok: true };
});

// ── arranque ──────────────────────────────────────────────────────────

const unico = app.requestSingleInstanceLock();
if (!unico) {
    // Dos agentes en la misma PC pelearían por la cola local. El segundo
    // solo levanta la ventana del primero.
    app.quit();
} else {
    app.on('second-instance', abrirVentana);

    app.whenReady().then(async () => {
        // Arrancar con Windows: sin esto, alguien tiene que acordarse de
        // abrir el programa cada mañana, y el día que no se acuerde no se
        // imprime nada.
        app.setLoginItemSettings({ openAtLogin: true });

        crearTray();
        await arrancarMotor();

        // Primera vez (sin token): se abre el asistente. Las siguientes,
        // silencio: directo a la bandeja.
        if (!leerConfig().token) abrirVentana();

        // Actualización automática desde GitHub Releases, sin molestar.
        try {
            const { autoUpdater } = require('electron-updater');
            autoUpdater.checkForUpdatesAndNotify().catch(() => {});
        } catch { /* en desarrollo no hay updater */ }
    });

    app.on('window-all-closed', () => { /* la bandeja mantiene vivo el agente */ });
}
