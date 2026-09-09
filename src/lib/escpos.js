/**
 * Convierte el payload de un trabajo en los BYTES ESC/POS que entiende una
 * impresora térmica.
 *
 * El campo `payload.tipo` elige la plantilla:
 *   - 'comanda_delivery'  → la comanda de cocina (sin dinero, letra grande)
 *   - 'cierre_caja'       → el resumen del turno («totalizador»)
 *   - cualquier otro/nada → ticket de venta o pre-cuenta, el formato que ya
 *                           emiten el POS y las mesas (payload con
 *                           ticketNumber, productos, metodosPago...). Así el
 *                           agente nuevo imprime TODO lo existente sin tocar
 *                           el servidor.
 *
 * Texto en CP858 (iconv-lite): es la página de códigos que las térmicas
 * traen para español — con ella «Ferreñafe» y «años» salen bien en papel.
 */
const iconv = require('iconv-lite');

const ESC = 0x1b;
const GS = 0x1d;

class Ticket {
    constructor(anchoPapel = 80) {
        this.partes = [];
        // 80 mm ≈ 48 columnas en fuente A; 58 mm ≈ 32.
        this.cols = anchoPapel === 58 ? 32 : 48;
        this.init();
    }

    raw(...bytes) { this.partes.push(Buffer.from(bytes)); return this; }

    init() {
        this.raw(ESC, 0x40);          // reset
        this.raw(ESC, 0x74, 19);      // página de códigos CP858 (con € y ñ)
        return this;
    }

    texto(s = '') {
        this.partes.push(iconv.encode(String(s), 'cp858'));
        return this;
    }

    linea(s = '') { return this.texto(s + '\n'); }
    centrar() { return this.raw(ESC, 0x61, 1); }
    izquierda() { return this.raw(ESC, 0x61, 0); }
    negrita(on = true) { return this.raw(ESC, 0x45, on ? 1 : 0); }

    /** Doble alto y ancho: para lo que la cocina lee a dos metros. */
    grande(on = true) { return this.raw(GS, 0x21, on ? 0x11 : 0x00); }
    /** Solo doble alto: títulos que no deben partirse en dos renglones. */
    alto(on = true) { return this.raw(GS, 0x21, on ? 0x01 : 0x00); }

    separador(char = '-') { return this.linea(char.repeat(this.cols)); }

    /** Izquierda y derecha en el mismo renglón («Total……  S/ 33.00»). */
    dosColumnas(izq, der) {
        izq = String(izq); der = String(der);
        const hueco = this.cols - izq.length - der.length;
        return this.linea(hueco > 0 ? izq + ' '.repeat(hueco) + der : izq + ' ' + der);
    }

    /** Parte un texto largo respetando el ancho, con sangría de continuación. */
    parrafo(s, sangria = 0) {
        const ancho = this.cols - sangria;
        const palabras = String(s).split(/\s+/).filter(Boolean);
        let renglon = '';
        for (const p of palabras) {
            if ((renglon + ' ' + p).trim().length > ancho) {
                this.linea(' '.repeat(sangria) + renglon.trim());
                renglon = p;
            } else {
                renglon += ' ' + p;
            }
        }
        if (renglon.trim()) this.linea(' '.repeat(sangria) + renglon.trim());
        return this;
    }

    cortar() {
        this.linea('').linea('').linea('');
        return this.raw(GS, 0x56, 0x42, 0x00); // corte parcial con avance
    }

    bytes() { return Buffer.concat(this.partes); }
}

// ─────────────────────────────────────────────────────────────────────

function comandaDelivery(p, ancho) {
    const t = new Ticket(ancho);

    t.centrar().grande().linea(p.titulo || 'PEDIDO DELIVERY').grande(false);
    t.alto().linea(`${p.pedido || ''}  ${p.hora || ''}`).alto(false);
    t.separador('=');

    t.izquierda();
    // La cocina lee esto a distancia y con prisa: los productos van GRANDES
    // y las notas justo debajo de su producto, no al final.
    for (const item of p.productos || []) {
        t.grande().linea(`${item.cantidad} x ${item.nombre}`).grande(false);
        if (item.nota) t.negrita().parrafo(`   >> ${item.nota}`, 3).negrita(false);
    }

    t.separador('=');
    t.negrita().linea('ENTREGAR A:').negrita(false);
    t.alto().parrafo(p.cliente || '').alto(false);
    if (p.telefono) t.linea(`Tel: ${p.telefono}`);
    t.parrafo(p.direccion || '');
    if (p.distrito) t.linea(p.distrito);
    if (p.motorizado) t.linea(`Lleva: ${p.motorizado}`);
    if (p.notas) { t.separador(); t.negrita().parrafo(`NOTA: ${p.notas}`).negrita(false); }

    t.separador();
    t.centrar().linea(`Ticket ${p.ticket || ''} · GestVenin`);
    return t.cortar().bytes();
}

function cierreCaja(p, ancho) {
    const t = new Ticket(ancho);
    const r = p.resumen || {};
    const money = (n) => 'S/ ' + Number(n || 0).toFixed(2);

    t.centrar().alto().linea(p.titulo || 'CIERRE DE CAJA').alto(false);
    t.linea(p.local || '').linea(p.fecha || '');
    t.linea(`Turno ${p.turno || ''} · ${p.cajero || ''}`);
    t.separador('=');

    t.izquierda();
    t.dosColumnas('Ventas (' + (r.cantidad_ventas ?? 0) + ')', money(r.total_ventas));
    if (Number(r.total_descuentos)) t.dosColumnas('Descuentos', '-' + money(r.total_descuentos));
    t.separador();

    t.negrita().linea('POR MÉTODO DE PAGO').negrita(false);
    for (const m of r.metodos || []) {
        t.dosColumnas(m.nombre, money(m.monto_sistema));
        if (m.diferencia != null && Number(m.diferencia) !== 0) {
            t.dosColumnas('  contado ' + money(m.monto_real), 'dif ' + money(m.diferencia));
        }
    }
    t.separador();

    t.dosColumnas('Monto inicial', money(r.monto_inicial));
    if (Number(r.total_gastos)) t.dosColumnas('Gastos', '-' + money(r.total_gastos));
    if (Number(r.total_movimientos_egreso)) t.dosColumnas('Egresos', '-' + money(r.total_movimientos_egreso));
    if (Number(r.total_movimientos_ingreso)) t.dosColumnas('Ingresos', '+' + money(r.total_movimientos_ingreso));
    t.negrita().dosColumnas('EFECTIVO ESPERADO', money(r.efectivo_esperado)).negrita(false);

    if ((r.productos || []).length) {
        t.separador();
        t.negrita().linea('LO VENDIDO').negrita(false);
        for (const prod of r.productos) {
            t.dosColumnas(
                `${Number(prod.cantidad)} x ${String(prod.nombre).slice(0, t.cols - 14)}`,
                money(prod.total),
            );
        }
    }

    t.separador('=');
    t.centrar().linea('GestVenin');
    return t.cortar().bytes();
}

/** Ticket de venta / pre-cuenta: el formato que YA emiten POS y mesas. */
function ticketVenta(p, ancho) {
    const t = new Ticket(ancho);
    const money = (n) => 'S/ ' + Number(n || 0).toFixed(2);
    const local = p.local || {};

    t.centrar().alto().linea(local.nombre || 'GestVenin').alto(false);
    if (local.ruc) t.linea('RUC ' + local.ruc);
    if (local.direccion) t.parrafo(local.direccion);
    if (local.telefono) t.linea('Tel: ' + local.telefono);
    t.separador('=');

    t.izquierda();
    if (p.ticketNumber) t.negrita().linea('TICKET ' + p.ticketNumber).negrita(false);
    if (p.dateTime) t.linea(p.dateTime);
    if (p.cajero) t.linea('Atiende: ' + p.cajero);
    if (p.mesa) t.linea('Mesa: ' + p.mesa);
    t.separador();

    for (const item of p.productos || []) {
        t.parrafo(item.nombre);
        t.dosColumnas(
            `  ${item.cantidad} x ${money(item.precio_unitario)}`,
            money(item.total),
        );
    }
    t.separador();

    if (p.subtotal && Number(p.subtotal) !== Number(p.total)) t.dosColumnas('Subtotal', money(p.subtotal));
    if (Number(p.descuento)) t.dosColumnas('Descuento', '-' + money(p.descuento));
    t.grande().dosColumnas('TOTAL', money(p.total)).grande(false);

    for (const m of p.metodosPago || []) t.dosColumnas(m.metodo, money(m.monto));
    if (p.subtotal_letras) { t.separador(); t.parrafo('SON: ' + p.subtotal_letras); }
    if (p.aviso) { t.separador(); t.centrar().linea(p.aviso); }

    t.separador('=');
    t.centrar().linea('¡Gracias por su compra!');
    return t.cortar().bytes();
}

/** Autoprueba: lo que sale al pulsar «Imprimir prueba» en una impresora. */
function prueba(nombre, ancho) {
    const t = new Ticket(ancho);
    t.centrar().grande().linea('GESTVENIN').grande(false);
    t.linea('Prueba de impresión');
    t.separador('=');
    t.izquierda();
    t.linea('Impresora: ' + nombre);
    t.linea('Ancho: ' + ancho + ' mm (' + t.cols + ' columnas)');
    t.linea('Acentos: áéíóú ñ Ñ ¡! ¿? S/ 10.50');
    t.separador();
    t.centrar().linea('Si esto se lee bien, está lista.');
    return t.cortar().bytes();
}

function render(payload, ancho = 80) {
    switch (payload?.tipo) {
        case 'comanda_delivery': return comandaDelivery(payload, ancho);
        case 'cierre_caja': return cierreCaja(payload, ancho);
        default: return ticketVenta(payload || {}, ancho);
    }
}

module.exports = { render, prueba };
