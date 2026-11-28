# API de pagos con Wompi

Envoltura tipada de la API de Wompi: crea sesiones de pago, valida la firma de los webhooks, procesa la devolucion con idempotencia y expone el estado de la transaccion por HTTP.

![CI](https://github.com/Chencho2323/api-wompi-pagos/actions/workflows/ci.yml/badge.svg)
![Licencia](https://img.shields.io/badge/licencia-MIT-03A8FA?style=flat-square)

**Stack:** Node.js 24 · SQLite · node --test

## Que resuelve

Este repositorio es parte del portafolio publico de
[InheritDevs](https://inheritdevs.com/): software empresarial que funciona en
produccion. El codigo esta aqui para que se pueda leer, ejecutar y auditar.

- Codigo completo, no un ejemplo recortado.
- Pruebas que corren en cada push (`npm test`, `phpunit` o `pytest`, segun el
  stack) y en cada pull request.
- Sin dependencias ocultas: lo que dice el README es lo que hace falta.

## Instalacion

```bash
git clone https://github.com/Chencho2323/api-wompi-pagos.git
cd api-wompi-pagos
```

Los comandos exactos de instalacion y ejecucion estan en la seccion siguiente.

## Uso

El cliente HTTP es la base de todo lo demas: arma la URL del entorno, manda
la llave y reintenta los fallos transitorios con espera exponencial.

```js
import { crearCliente } from 'api-wompi-pagos';

const wompi = crearCliente({
  llave: process.env.WOMPI_LLAVE_PRIVADA,
  entorno: 'sandbox',   // 'produccion' cuando salga a la calle
  timeoutMs: 10_000,    // por intento, no por la llamada completa
  reintentos: 3,        // intentos totales, contando el primero
});

const transaccion = await wompi.solicitar('/transactions/1234-5678');
```

Se reintentan los estados 408, 425, 429, 500, 502, 503 y 504, ademas de
cualquier 5xx. Un 4xx de validacion no se reintenta: el problema esta en los
datos. Cuando el servidor manda `Retry-After`, ese valor manda sobre la
espera calculada, con el tope de `maxEsperaMs`.

Los fallos llegan como `ErrorWompi`, con `estado`, `ruta`, `intentos` y
`codigo` (`HTTP`, `RED`, `RESPUESTA` o `CONFIGURACION`) para decidir si vale
la pena volver a intentar mas tarde.

### Cobrar

Con el mismo cliente se arman las dos formas de cobro: la sesion de pago, para
el checkout propio, y el enlace de pago, para compartir por correo o mensajeria.

```js
import { crearSesionPago, crearEnlacePago } from 'api-wompi-pagos';

const sesion = await crearSesionPago(wompi, {
  montoEnCentavos: 250_000,          // 2500 pesos
  referencia: 'pedido-1042',
  correoCliente: 'cliente@ejemplo.com',
  urlRetorno: 'https://tienda.ejemplo.com/gracias',
});

console.log(sesion.urlCheckout);      // https://checkout.wompi.co/l/ps_123

const enlace = await crearEnlacePago(wompi, {
  nombre: 'Cuota de mantenimiento',
  montoEnCentavos: 480_000,
  referencia: 'cuota-2026-11',
  unSoloUso: true,
});
```

Los montos van en centavos y las referencias son de quien cobra: sirven para
cuadrar el pago contra el pedido. Los datos invalidos (monto, moneda,
referencia, correo o direccion de retorno) se rechazan antes de llamar a
Wompi, con `codigo: 'VALIDACION'`.

### Confirmar un pago con el webhook

El aviso de Wompi llega por HTTP y hay que verificar la firma antes de tocar
nada. Un evento sin firma buena, o con mas de cinco minutos de viejo, se
descarta y se responde 400.

```js
import { verificarFirmaEvento } from 'api-wompi-pagos';

try {
  const evento = verificarFirmaEvento(cuerpoCrudo, {
    secretoEventos: process.env.WOMPI_EVENTOS,
    cabeceras: peticion.headers,
  });

  if (evento.transaccion.estado === 'APPROVED') {
    // marcar el pedido como pagado y responder 200
  }
} catch (error) {
  if (error.codigo === 'FIRMA') return responder(400, 'firma invalida');
  throw error;
}
```

La cadena firmada se arma con los campos que declara el propio evento en
`signature.properties`, el `timestamp` y el secreto de eventos. La comparacion
es en tiempo constante, y se acepta el checksum tanto en la cabecera
`X-Event-Checksum` como en `signature.checksum`. La ventana de tiempo se ajusta
con `toleranciaSegundos` (300 por defecto, 0 para desactivarla).

### Aplicar el evento una sola vez

Wompi reintenta el webhook si la respuesta tarda, asi que el mismo aviso llega
varias veces. El registro guarda la llave del evento aplicado y el segundo
intento no vuelve a tocar el pedido.

```js
import { abrirRegistro, procesarEvento } from 'api-wompi-pagos';

const registro = abrirRegistro({ archivo: 'datos/pagos.db' });

const resultado = await procesarEvento(evento, {
  registro,
  manejador: async (aviso) => {
    // marcar el pedido como pagado, avisar al cliente, etc.
  },
});

// resultado.duplicado === true en el reintento: ya se respondio 200 antes.
```

Si el manejador falla, la marca se suelta y el reintento de Wompi si aplica el
evento. Un trabajo que no quedo hecho no puede quedar marcado como hecho.

### Devoluciones

La referencia es la llave. Dos clics en el boton producen una sola llamada a
Wompi y la misma ficha de vuelta.

```js
import { solicitarDevolucion } from 'api-wompi-pagos';

const devolucion = await solicitarDevolucion(wompi, registro, {
  transaccion: '1234-5678-9012',
  montoEnCentavos: 250_000,
  referencia: 'devolucion-pedido-1042',
  motivo: 'el cliente devolvio el producto',
  montoOriginalEnCentavos: 250_000, // opcional: corta el exceso antes de llamar
});

// devolucion.duplicado === true si ya se habia pedido con esa referencia.
```

Estados que se guardan: `PENDIENTE` mientras sale la peticion, el estado que
devuelva Wompi, `FALLIDA` cuando la rechaza (se puede reintentar con la misma
referencia) e `INDETERMINADA` cuando el fallo fue de red o 5xx. Esa ultima no
se reintenta sola: la peticion pudo haber llegado y repetirla devolveria la
plata dos veces. Hay que mirarla en el panel de Wompi primero.

`saldoDevolvible(registro, transaccion, montoOriginalEnCentavos)` dice cuanto
queda por devolver de un pago con varias devoluciones parciales.

### El flujo completo por HTTP

`crearServidor` levanta las seis rutas del flujo con `node:http`, sin framework
de por medio. Sirve para montar el cobro de una tienda o para tener un receptor
de webhooks en un servidor pequeño.

```js
import { crearCliente, crearServidor, abrirRegistro } from 'api-wompi-pagos';

const app = crearServidor({
  cliente: crearCliente({ llave: process.env.WOMPI_LLAVE_PRIVADA, entorno: 'sandbox' }),
  registro: abrirRegistro({ archivo: 'datos/pagos.db' }),
  secretoEventos: process.env.WOMPI_EVENTOS,
  manejador: async (evento) => {
    if (evento.transaccion.estado === 'APPROVED') {
      // marcar el pedido como pagado
    }
  },
});

const { url } = await app.escuchar(3000);
```

| Ruta | Para que |
|---|---|
| `POST /sesiones` | Abre una sesion de pago. Responde 201 con `id`, `estado` y `urlCheckout`. |
| `POST /enlaces` | Crea un enlace de pago. Responde 201 con la ficha del enlace. |
| `GET /transacciones/:id` | Estado de una transaccion, leido de Wompi. |
| `POST /devoluciones` | Pide una devolucion. 201 la primera vez, 200 con `duplicado: true` en el reintento. |
| `GET /devoluciones/:transaccion/saldo?montoOriginalEnCentavos=N` | Cuanto queda por devolver. |
| `POST /webhooks/wompi` | Recibe el aviso firmado. 200 si quedo aplicado o ya estaba; 400 si la firma no sirve; 500 si el manejador fallo. |

Los cuerpos van en JSON con los mismos nombres que las funciones de arriba. Los
errores salen con `{ error, codigo }`: 400 para `VALIDACION` y `FIRMA`, 502
cuando el fallo viene de Wompi y 500 cuando el problema es del servidor. El
webhook se verifica sobre el cuerpo crudo, sin volver a serializar, y una entrega
repetida no vuelve a llamar al manejador.

## Configuracion

| Variable | Para que |
|---|---|
| `WOMPI_LLAVE_PRIVADA` | Llave privada del comercio. Nunca se escribe en el repositorio. |
| `WOMPI_EVENTOS` | Secreto de firma de los eventos, para el webhook. |

## Pruebas

```bash
# el comando exacto lo declara el proyecto en verificar.sh
./verificar.sh
```

## Estructura

```
src/        codigo de la aplicacion
src/cliente.js      cliente HTTP: entornos, timeouts, reintentos
src/pagos.js        sesiones de pago y enlaces de pago
src/webhooks.js     verificacion de la firma de los eventos
src/registro.js     registro SQLite de eventos aplicados y devoluciones
src/idempotencia.js eventos y devoluciones que no se repiten
src/servidor.js     servidor HTTP con el flujo completo
test(s)/    pruebas automaticas
docs/       documentacion de uso
```

## Licencia

MIT. Ver `LICENSE`.
