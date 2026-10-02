/**
 * Convierte el payload de un trabajo en los BYTES ESC/POS que entiende una
 * impresora térmica.
 *
 * El campo `payload.tipo` elige la plantilla:
 *   - 'comanda_delivery'  → la comanda de cocina (sin dinero, letra grande)
 *   - 'cierre_caja'       → el resumen del turno («totalizador»)
 *   - 'comprobante_electronico' → boleta o factura electrónica: encabezado
 *                           del RUC emisor, serie-número, IGV y QR SUNAT
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

    /**
     * Letra pequeña (fuente B): leyendas y hash. Cabe más por renglón, así
     * que el ancho de `parrafo()` se ajusta mientras está activa.
     */
    chico(on = true) {
        if (on && !this.colsNormal) { this.colsNormal = this.cols; this.cols = this.cols === 32 ? 42 : 64; }
        if (!on && this.colsNormal) { this.cols = this.colsNormal; this.colsNormal = null; }
        return this.raw(ESC, 0x4d, on ? 1 : 0);
    }

    /**
     * Código QR nativo de la impresora (GS ( k, modelo 2, corrección M). Lo
     * dibuja la propia térmica: nada de imágenes que dependan del modelo.
     */
    qr(datos, modulo = 6) {
        const d = Buffer.from(String(datos), 'ascii');
        const largo = d.length + 3;
        this.raw(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00);                // modelo 2
        this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, modulo);                    // tamaño del módulo
        this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31);                      // corrección M
        this.raw(GS, 0x28, 0x6b, largo & 0xff, largo >> 8, 0x31, 0x50, 0x30);  // guardar…
        this.partes.push(d);
        this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30);                      // …e imprimir
        return this.linea('');
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

/**
 * Vale de gasto: el respaldo firmado de un pago sin comprobante (un técnico,
 * un servicio). Lo esencial es el monto en letras y las dos firmas.
 */
function vale(p, ancho) {
    const t = new Ticket(ancho);
    const money = (n) => 'S/ ' + Number(n || 0).toFixed(2);

    t.centrar();
    if (p.empresa) t.negrita().linea(p.empresa).negrita(false);
    if (p.ruc) t.linea('RUC ' + p.ruc);
    t.alto().linea(p.titulo || 'VALE').alto(false);
    t.negrita().linea('N° ' + (p.numero || '')).negrita(false);
    t.linea(p.local || '').linea(p.fecha || '');
    t.separador('=');

    t.izquierda();
    if (p.entregado_a) {
        t.negrita().linea('Entregado a:').negrita(false);
        t.parrafo(p.entregado_a + (p.documento ? ' · ' + p.documento : ''), 2);
    }
    t.negrita().linea('Concepto:').negrita(false);
    t.parrafo(p.concepto || '', 2);
    if (p.observaciones) t.parrafo(p.observaciones, 2);
    if (p.comprobante) t.dosColumnas('Comprobante', p.comprobante);
    if (p.metodo_pago) t.dosColumnas('Pagado con', p.metodo_pago);
    t.separador();

    t.centrar().grande().linea(money(p.monto)).grande(false);
    t.parrafo('SON: ' + (p.monto_letras || ''));
    t.separador();

    t.izquierda().linea('').linea('').linea('');
    t.centrar().linea('_'.repeat(Math.min(28, t.cols)));
    t.linea('Entregué conforme');
    if (p.registrado_por) t.linea(p.registrado_por);
    t.linea('').linea('').linea('');
    t.linea('_'.repeat(Math.min(28, t.cols)));
    t.linea('Recibí conforme');
    t.linea('DNI: ____________________');
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

    // Recibido y vuelto: el papel que zanja «me diste mal el cambio».
    if (p.pagaCon != null) {
        t.dosColumnas('Recibido', money(p.pagaCon));
        t.negrita().dosColumnas('VUELTO', money(p.vuelto)).negrita(false);
    }
    if (p.subtotal_letras) { t.separador(); t.parrafo('SON: ' + p.subtotal_letras); }
    if (p.aviso) { t.separador(); t.centrar().linea(p.aviso); }

    t.separador('=');
    t.centrar().linea('¡Gracias por su compra!');
    return t.cortar().bytes();
}

/**
 * Representación impresa de una BOLETA o FACTURA electrónica.
 *
 * El encabezado es el del RUC que emitió (razón social, RUC, domicilio
 * fiscal), no el del local: con varios RUC en una empresa, cada local
 * factura con el suyo y el papel tiene que decir cuál. El local va debajo,
 * como nombre comercial y establecimiento.
 *
 * Todo llega calculado por el ERP y el emisor (número, IGV, QR): aquí no se
 * recalcula nada, solo se dibuja. Un campo null no imprime su renglón.
 */
function comprobanteElectronico(p, ancho) {
    const t = new Ticket(ancho);
    const emisor = p.emisor || {};
    const local = p.local || {};
    const doc = p.documento || {};
    const cli = p.cliente || {};
    const tot = p.totales || {};
    const moneda = !tot.moneda || tot.moneda === 'PEN' ? 'S/' : tot.moneda;
    const money = (n) => moneda + ' ' + Number(n || 0).toFixed(2);
    const hay = (n) => n != null && n !== '' && Number(n) !== 0;
    const cant = (n) => String(Number(n || 0));

    // ── emisor y local ──
    t.centrar();
    if (emisor.razon_social) t.negrita().parrafo(emisor.razon_social).negrita(false);
    if (emisor.ruc) t.negrita().linea('RUC ' + emisor.ruc).negrita(false);
    if (emisor.direccion_fiscal) t.parrafo(emisor.direccion_fiscal);
    if (local.nombre) t.linea(local.nombre);
    if (local.direccion) t.parrafo(local.direccion);
    if (local.telefono) t.linea('Tel: ' + local.telefono);
    t.separador('=');

    // ── tipo y número ──
    t.negrita().parrafo(doc.titulo || 'COMPROBANTE ELECTRÓNICO');
    if (doc.numero) t.alto().linea(doc.numero).alto(false);
    t.negrita(false);
    if (doc.prueba) t.negrita().linea('*** PRUEBA - SIN VALOR LEGAL ***').negrita(false);
    t.separador();

    // ── fecha, quien atiende y cliente ──
    t.izquierda();
    if (doc.fecha) t.linea('Fecha: ' + doc.fecha);
    if (doc.cajero) t.linea('Atiende: ' + doc.cajero);
    if (doc.mesa) t.linea('Mesa: ' + doc.mesa);
    if (cli.nombre || !cli.documento) t.parrafo('Cliente: ' + (cli.nombre || 'CLIENTES VARIOS'));
    if (cli.documento) t.linea(cli.documento);
    if (cli.direccion) t.parrafo('Dir: ' + cli.direccion);
    t.separador();

    // ── productos ──
    t.negrita().dosColumnas('DESCRIPCIÓN', 'IMPORTE').negrita(false);
    for (const item of p.productos || []) {
        t.parrafo(item.nombre);
        t.dosColumnas(`  ${cant(item.cantidad)} x ${money(item.precio_unitario)}`, money(item.total));
        if (hay(item.descuento)) t.dosColumnas('  Descuento', '-' + money(item.descuento));
    }
    t.separador();

    // ── totales: alineados a la derecha, solo lo que tiene importe ──
    const fila = (etiqueta, valor) => {
        const v = String(valor);
        t.linea(etiqueta.padStart(t.cols - 14) + v.padStart(14));
    };
    if (hay(tot.gravada)) fila('Op. Gravada', money(tot.gravada));
    if (hay(tot.exonerada)) fila('Op. Exonerada', money(tot.exonerada));
    if (hay(tot.inafecta)) fila('Op. Inafecta', money(tot.inafecta));
    if (hay(tot.descuento)) fila('Descuento', '-' + money(tot.descuento));
    if (tot.igv != null) fila('IGV' + (tot.igv_tasa ? ` (${Number(tot.igv_tasa)}%)` : ''), money(tot.igv));
    t.negrita().alto().dosColumnas('TOTAL', money(tot.total)).alto(false).negrita(false);
    if (p.letras) t.parrafo('SON: ' + p.letras);
    t.separador();

    // ── pago ──
    for (const m of p.metodosPago || []) t.dosColumnas(m.metodo, money(m.monto));
    if (p.pagaCon != null) {
        t.dosColumnas('Recibido', money(p.pagaCon));
        t.negrita().dosColumnas('VUELTO', money(p.vuelto)).negrita(false);
    }

    // ── QR, hash y leyenda SUNAT ──
    t.centrar();
    if (p.qr) { t.linea(''); t.qr(p.qr, ancho === 58 ? 4 : 6); }
    if (p.hash) t.chico().parrafo('Hash: ' + p.hash).chico(false);
    if ((p.leyenda || []).length) {
        t.chico();
        for (const l of p.leyenda) t.parrafo(l);
        t.chico(false);
    }

    t.separador('=');
    t.linea('¡Gracias por su compra!');
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
        case 'comprobante_electronico': return comprobanteElectronico(payload, ancho);
        case 'vale': return vale(payload, ancho);
        default: return ticketVenta(payload || {}, ancho);
    }
}

module.exports = { render, prueba };
