// Servidor HTTP con los endpoints del flujo de pago.
//
// La envoltura de Wompi sirve de poco si para usarla hay que escribir el
// pegamento en cada proyecto: leer el cuerpo crudo del webhook, mapear los
// errores a estados HTTP, decidir que se responde cuando el evento ya se
// aplico. Todo eso vive aqui, en un solo archivo y sin dependencias: `node:http`
// alcanza para las seis rutas del flujo.
//
//   POST /sesiones                     abre una sesion de pago (checkout propio)
//   POST /enlaces                      crea un enlace de pago
//   GET  /transacciones/:id            estado de una transaccion en Wompi
//   POST /devoluciones                 pide una devolucion idempotente
//   GET  /devoluciones/:id/saldo       cuanto queda por devolver de un pago
//   POST /webhooks/wompi               recibe el aviso de Wompi, ya firmado
//
// El webhook responde 200 cuando el evento quedo aplicado o cuando ya estaba
// aplicado: en los dos casos Wompi no tiene por que reintentar. Si el manejador
// falla, responde 500 y la marca del evento se suelta, asi el reintento del
// proveedor si puede aplicarlo.

import { createServer } from 'node:http';

import { ErrorWompi } from './cliente.js';
import { crearSesionPago, crearEnlacePago } from './pagos.js';
import { verificarFirmaEvento } from './webhooks.js';
import { procesarEvento, solicitarDevolucion, saldoDevolvible } from './idempotencia.js';

/** Tamano maximo del cuerpo de una peticion. Un webhook de Wompi pesa pocos KB. */
export const MAXIMO_BYTES = 1_000_000;

/** Estado HTTP que corresponde a cada codigo de error. */
const ESTADOS_POR_CODIGO = {
  VALIDACION: 400,
  FIRMA: 400,
  CONFIGURACION: 500,
  RED: 502,
  HTTP: 502,
  RESPUESTA: 502,
};

/** Lee el cuerpo crudo de la peticion, con tope de tamano. */
function leerCuerpoCrudo(peticion, maximoBytes) {
  return new Promise((resolver, rechazar) => {
    const trozos = [];
    let total = 0;

    peticion.on('data', (trozo) => {
      total += trozo.length;
      if (total > maximoBytes) {
        const error = new ErrorWompi('El cuerpo de la peticion pasa del limite permitido.', {
          codigo: 'VALIDACION',
        });
        error.estadoHttp = 413;
        rechazar(error);
        peticion.destroy();
        return;
      }
      trozos.push(trozo);
    });

    peticion.on('end', () => resolver(Buffer.concat(trozos)));
    peticion.on('error', rechazar);
  });
}

/** Interpreta el cuerpo como JSON. Un cuerpo vacio es un objeto vacio. */
function leerJson(crudo) {
  if (!crudo || crudo.length === 0) return {};

  try {
    return JSON.parse(crudo.toString('utf8'));
  } catch {
    throw new ErrorWompi('El cuerpo de la peticion no es JSON valido.', { codigo: 'VALIDACION' });
  }
}

/** Responde JSON con el estado indicado. */
function responder(respuesta, estado, cuerpo) {
  const texto = JSON.stringify(cuerpo ?? {});
  respuesta.writeHead(estado, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
  });
  respuesta.end(texto);
}

/** Ficha de una transaccion, normalizada para no exponer la forma cruda de Wompi. */
function fichaTransaccion(respuestaWompi) {
  const datos = respuestaWompi?.data;
  if (!datos || typeof datos !== 'object') {
    throw new ErrorWompi('Wompi no devolvio los datos de la transaccion.', { codigo: 'RESPUESTA' });
  }

  return {
    id: datos.id ?? null,
    estado: datos.status ?? null,
    referencia: datos.reference ?? null,
    montoEnCentavos: datos.amount_in_cents ?? null,
    moneda: datos.currency ?? null,
  };
}

/** Estado HTTP de un error, segun su codigo. */
function estadoDeError(error) {
  if (Number.isInteger(error?.estadoHttp)) return error.estadoHttp;
  return ESTADOS_POR_CODIGO[error?.codigo] ?? 500;
}

/**
 * Crea el servidor con el flujo completo.
 *
 * @param {object} opciones
 * @param {{solicitar: Function}} opciones.cliente Cliente de `crearCliente`.
 * @param {object} opciones.registro Registro abierto con `abrirRegistro`.
 * @param {string} opciones.secretoEventos Secreto de firma de los webhooks.
 * @param {Function} [opciones.manejador] Trabajo que se hace con el evento ya
 *   verificado. Si no se pasa, el evento se marca como aplicado y nada mas.
 * @param {number} [opciones.toleranciaSegundos] Ventana de tiempo del evento.
 * @param {number} [opciones.maximoBytes] Tope del cuerpo de una peticion.
 * @param {Function} [opciones.ahora] Reloj inyectable, en milisegundos.
 * @returns {object} Servidor con `escuchar` y `cerrar`.
 */
export function crearServidor({
  cliente,
  registro,
  secretoEventos,
  manejador = null,
  toleranciaSegundos,
  maximoBytes = MAXIMO_BYTES,
  ahora = () => Date.now(),
} = {}) {
  if (!cliente || typeof cliente.solicitar !== 'function') {
    throw new ErrorWompi('Hace falta el cliente de Wompi. Se crea con crearCliente().', {
      codigo: 'CONFIGURACION',
    });
  }
  if (!registro || typeof registro.marcarEvento !== 'function') {
    throw new ErrorWompi('Hace falta el registro de eventos. Se abre con abrirRegistro().', {
      codigo: 'CONFIGURACION',
    });
  }
  if (typeof secretoEventos !== 'string' || secretoEventos.trim() === '') {
    throw new ErrorWompi('Falta el secreto de eventos: sin el no se puede verificar un webhook.', {
      codigo: 'CONFIGURACION',
    });
  }

  /** Webhook: verifica la firma sobre el cuerpo crudo y aplica el evento una sola vez. */
  async function atenderWebhook(crudo, cabeceras) {
    const evento = verificarFirmaEvento(crudo, {
      secretoEventos,
      cabeceras,
      toleranciaSegundos,
      ahoraMs: ahora(),
    });

    const resultado = await procesarEvento(evento, {
      registro,
      manejador: manejador ?? (async () => null),
    });

    return {
      estado: 200,
      cuerpo: {
        recibido: true,
        aplicado: resultado.aplicado,
        duplicado: resultado.duplicado,
        tipo: evento.tipo,
        transaccion: evento.transaccion?.id ?? null,
      },
    };
  }

  /** Reparte la peticion entre las rutas del flujo. */
  async function atender(peticion, respuesta) {
    const url = new URL(peticion.url, 'http://localhost');
    const partes = url.pathname.split('/').filter((parte) => parte !== '');
    const metodo = peticion.method ?? 'GET';

    const ruta = `${metodo} /${partes.join('/')}`;
    const crudo = ['POST', 'PUT', 'PATCH'].includes(metodo)
      ? await leerCuerpoCrudo(peticion, maximoBytes)
      : Buffer.alloc(0);

    // POST /sesiones
    if (metodo === 'POST' && partes.length === 1 && partes[0] === 'sesiones') {
      const sesion = await crearSesionPago(cliente, leerJson(crudo));
      return responder(respuesta, 201, sesion);
    }

    // POST /enlaces
    if (metodo === 'POST' && partes.length === 1 && partes[0] === 'enlaces') {
      const enlace = await crearEnlacePago(cliente, leerJson(crudo));
      return responder(respuesta, 201, enlace);
    }

    // GET /transacciones/:id
    if (metodo === 'GET' && partes.length === 2 && partes[0] === 'transacciones') {
      const id = decodeURIComponent(partes[1]);
      if (id.trim() === '') {
        return responder(respuesta, 400, { error: 'Falta el identificador de la transaccion.' });
      }
      const datos = await cliente.solicitar(`/transactions/${encodeURIComponent(id)}`);
      return responder(respuesta, 200, fichaTransaccion(datos));
    }

    // POST /devoluciones
    if (metodo === 'POST' && partes.length === 1 && partes[0] === 'devoluciones') {
      const devolucion = await solicitarDevolucion(cliente, registro, leerJson(crudo));
      return responder(respuesta, devolucion.duplicado ? 200 : 201, devolucion);
    }

    // GET /devoluciones/:transaccion/saldo?montoOriginalEnCentavos=N
    if (
      metodo === 'GET'
      && partes.length === 3
      && partes[0] === 'devoluciones'
      && partes[2] === 'saldo'
    ) {
      const original = Number(url.searchParams.get('montoOriginalEnCentavos'));
      const saldo = saldoDevolvible(registro, decodeURIComponent(partes[1]), original);
      return responder(respuesta, 200, {
        transaccion: decodeURIComponent(partes[1]),
        saldoEnCentavos: saldo,
      });
    }

    // POST /webhooks/wompi
    if (metodo === 'POST' && partes.length === 2 && partes[0] === 'webhooks' && partes[1] === 'wompi') {
      const resultado = await atenderWebhook(crudo, peticion.headers);
      return responder(respuesta, resultado.estado, resultado.cuerpo);
    }

    return responder(respuesta, 404, { error: `No existe la ruta ${ruta}.` });
  }

  const servidor = createServer((peticion, respuesta) => {
    atender(peticion, respuesta).catch((error) => {
      if (respuesta.headersSent) {
        respuesta.destroy();
        return;
      }
      responder(respuesta, estadoDeError(error), {
        error: error?.message ?? 'Fallo inesperado del servidor.',
        codigo: error?.codigo ?? null,
      });
    });
  });

  return {
    servidor,

    /**
     * Pone a escuchar el servidor.
     *
     * @param {number} [puerto] Puerto TCP. Con 0 el sistema elige uno libre.
     * @returns {Promise<{puerto: number, url: string}>} Direccion donde atiende.
     */
    escuchar(puerto = 0) {
      return new Promise((resolver, rechazar) => {
        servidor.once('error', rechazar);
        servidor.listen(puerto, '127.0.0.1', () => {
          servidor.removeListener('error', rechazar);
          const direccion = servidor.address();
          resolver({ puerto: direccion.port, url: `http://127.0.0.1:${direccion.port}` });
        });
      });
    },

    /** Cierra el servidor y suelta el puerto. */
    cerrar() {
      return new Promise((resolver, rechazar) => {
        servidor.close((error) => (error ? rechazar(error) : resolver()));
      });
    },
  };
}
