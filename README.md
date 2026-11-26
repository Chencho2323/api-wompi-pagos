# API de pagos con Wompi

Envoltura tipada de la API de Wompi: crea sesiones de pago, valida la firma de los webhooks, procesa la devolucion con idempotencia y expone el estado de la transaccion.

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
src/cliente.js  cliente HTTP: entornos, timeouts, reintentos
src/pagos.js    sesiones de pago y enlaces de pago
src/webhooks.js verificacion de la firma de los eventos
test(s)/    pruebas automaticas
docs/       documentacion de uso
```

## Licencia

MIT. Ver `LICENSE`.
