# GestVenin Impresión

El agente que corre en la PC del local: recibe los tickets del ERP y los
imprime en las térmicas, **reaccionando al instante** (WebSocket contra
Reverb) en vez de vivir preguntando si hay algo.

## Qué hace

- **Arranca con Windows** y vive en la bandeja, junto al reloj.
- **Encuentra las impresoras solo**, por tres canales a la vez: el spooler de
  Windows (USB), mDNS/Bonjour y un barrido del puerto 9100 en la red del
  local. Objetivo: todas visibles en menos de 3 segundos.
- **Imprime por destino**: la comanda del delivery por la de cocina, el
  ticket de venta y el cierre por la de caja. Qué impresora atiende cada
  destino se asigna **desde la web del ERP**, no aquí.
- **Cola en disco**: si se corta internet o la luz, lo pendiente sale al
  volver, en orden y sin repetirse.
- **Se actualiza solo** desde las publicaciones de GitHub.

## Instalar en el local

1. Descargar el instalador `.exe` de la última versión en Releases.
2. Abrirlo (Windows avisará de «editor desconocido» mientras no esté
   firmado: Más información → Ejecutar de todas formas).
3. Pegar el **token de impresión del local** (ERP → Configuración → Locales
   → Token de impresora).
4. Pulsar **Buscar impresoras** y probar cada una con «Imprimir prueba».
5. En el ERP, asignar qué impresora es **caja** y cuál **cocina**.

## Desarrollo (desde Mac o Windows)

```bash
npm install
npm start          # abre el agente en modo desarrollo
```

Casi todo se prueba desde un Mac: una térmica de red es un socket al puerto
9100 y responde igual. Solo el camino USB (spooler, `raw-print.ps1`) exige
Windows.

## Publicar una versión

```bash
git tag v0.1.0 && git push --tags
```

GitHub Actions compila el instalador en un runner Windows y lo publica en
Releases. No hace falta tener una PC con Windows.

## Cómo habla con el ERP

| Cuándo | Qué |
|---|---|
| Al encolar un ticket | El ERP emite `trabajo.encolado` por Reverb → el agente reclama al instante |
| Cada 90 s | Sondeo de respaldo, solo por si el WebSocket cayó |
| Cada 60 s | Latido: reporta vida y recibe la configuración vigente (destinos, canal, URL del WebSocket) |
| Al buscar impresoras | `POST /api/impresora/registrar` con lo hallado |

El reclamo del servidor es atómico (`FOR UPDATE SKIP LOCKED`): dos agentes a
la vez jamás imprimen el mismo ticket dos veces. Un trabajo colgado en
`printing` más de 5 minutos vuelve a la cola; al tercer intento queda
`failed` con su motivo, visible en el ERP.
