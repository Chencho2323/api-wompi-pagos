// Verificacion de la firma de los eventos de Wompi.
//
// Un webhook es una peticion que llega de la calle y que dice "esta transaccion
// ya se pago". Si se cree sin revisar nada, cualquiera puede mandar el mismo
// JSON y marcar un pedido como pagado. La firma es lo unico que separa el aviso
// de verdad de la copia.
//
// Wompi firma con SHA-256 sobre una cadena armada asi: el valor de cada campo
// que lista `signature.properties` (rutas como `transaction.id`), despues el
// `timestamp` del evento y al final el secreto de eventos del comercio. El
// resultado va en el campo `signature.checksum` del cuerpo y, en la mayoria de
// los casos, tambien en la cabecera `X-Event-Checksum`.
//
// Aqui se comprueba la firma en tiempo constante, se rechazan los eventos
// viejos (para que un cuerpo capturado no sirva para siempre) y se devuelve una
// ficha con lo que la aplicacion necesita: que paso, cuando y con que
// transaccion.

import { createHash, timingSafeEqual } from 'node:crypto';

import { ErrorWompi } from './cliente.js';

/** Cabecera donde Wompi manda el checksum. Los nombres de cabecera no distinguen mayusculas. */
export const CABECERA_CHECKSUM = 'x-event-checksum';

/** Tolerancia por defecto frente a la hora del evento, en segundos. */
export const TOLERANCIA_SEGUNDOS = 300;

/** Largo de un checksum SHA-256 escrito en hexadecimal. */
const LARGO_CHECKSUM = 64;

/** Falla con el codigo que corresponde: firma invalida o evento mal formado. */
function fallar(mensaje, codigo = 'FIRMA', extra = {}) {
  throw new ErrorWompi(mensaje, { codigo, ...extra });
}

/** Interpreta el cuerpo del webhook venga como objeto, texto o Buffer. */
function leerCuerpo(cuerpo) {
  if (Buffer.isBuffer(cuerpo)) {
    return leerCuerpo(cuerpo.toString('utf8'));
  }
  if (typeof cuerpo === 'string') {
    if (cuerpo.trim() === '') {
      fallar('El cuerpo del evento llego vacio.', 'VALIDACION');
    }
    try {
      return JSON.parse(cuerpo);
    } catch {
      fallar('El cuerpo del evento no es JSON valido.', 'VALIDACION');
    }
  }
  if (cuerpo && typeof cuerpo === 'object') {
    return cuerpo;
  }
  fallar('Hace falta el cuerpo del evento para verificar la firma.', 'VALIDACION');
}

/**
 * Busca un valor dentro del evento usando una ruta con puntos.
 *
 * `transaction.id` entra por `data.transaction.id`; tambien se acepta la ruta
 * completa escrita desde la raiz. Devuelve `undefined` cuando no existe, y eso
 * basta para que la firma no cuadre.
 */
function tomarValor(evento, ruta) {
  if (typeof ruta !== 'string' || ruta.trim() === '') return undefined;

  const partes = ruta.trim().split('.').filter((parte) => parte !== '');
  const raices = [evento?.data, evento].filter((raiz) => raiz && typeof raiz === 'object');

  for (const raiz of raices) {
    let actual = raiz;
    let completa = true;

    for (const parte of partes) {
      if (actual && typeof actual === 'object' && parte in actual) {
        actual = actual[parte];
      } else {
        completa = false;
        break;
      }
    }

    if (completa) return actual;
  }

  return undefined;
}

/** Convierte el valor de un campo a texto, tal como lo concatena Wompi. */
function comoTexto(valor) {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'object') return JSON.stringify(valor);
  return String(valor);
}

/** Compara dos checksums sin filtrar por tiempo donde se diferencian. */
function compararEnTiempoConstante(esperado, recibido) {
  if (typeof esperado !== 'string' || typeof recibido !== 'string') return false;

  const izquierda = Buffer.from(esperado.toLowerCase(), 'utf8');
  const derecha = Buffer.from(recibido.toLowerCase(), 'utf8');

  // timingSafeEqual exige el mismo largo, y avisar del largo no dice nada util
  // a quien intenta adivinar la firma.
  if (izquierda.length !== derecha.length) return false;

  return timingSafeEqual(izquierda, derecha);
}

/**
 * Arma la cadena que Wompi firma y devuelve su SHA-256 en hexadecimal.
 *
 * Exportada porque sirve para probar la integracion desde el otro lado: un
 * simulador de Wompi o un script de diagnostico pueden firmar un evento con la
 * misma regla.
 *
 * @param {object} evento Cuerpo del evento, ya interpretado.
 * @param {string} secretoEventos Secreto de firma del comercio.
 * @returns {string} Checksum en hexadecimal, en minusculas.
 */
export function calcularFirma(evento, secretoEventos) {
  if (typeof secretoEventos !== 'string' || secretoEventos.trim() === '') {
    fallar('Falta el secreto de eventos de Wompi.', 'VALIDACION');
  }

  const cuerpo = leerCuerpo(evento);
  const propiedades = cuerpo?.signature?.properties;

  if (!Array.isArray(propiedades)) {
    fallar('El evento no trae la lista de campos firmados en signature.properties.', 'VALIDACION');
  }
  if (cuerpo.timestamp === undefined || cuerpo.timestamp === null) {
    fallar('El evento no trae timestamp; sin el no se puede verificar la firma.', 'VALIDACION');
  }

  const partes = propiedades.map((ruta) => comoTexto(tomarValor(cuerpo, ruta)));
  partes.push(comoTexto(cuerpo.timestamp));
  partes.push(secretoEventos);

  return createHash('sha256').update(partes.join(''), 'utf8').digest('hex');
}

/** Saca el checksum de la cabecera o, si no vino, del cuerpo. */
function tomarChecksum(cuerpo, cabeceras) {
  const crudo = cabeceras?.[CABECERA_CHECKSUM] ?? cabeceras?.['X-Event-Checksum'] ?? null;

  // Algunos frameworks entregan las cabeceras como arreglo.
  const deCabecera = Array.isArray(crudo) ? crudo[0] : crudo;

  if (typeof deCabecera === 'string' && deCabecera.trim() !== '') {
    return deCabecera.trim();
  }
  if (typeof cuerpo?.signature?.checksum === 'string' && cuerpo.signature.checksum.trim() !== '') {
    return cuerpo.signature.checksum.trim();
  }
  return null;
}

/** Toma la hora del evento en segundos. Wompi la manda como entero. */
function tomarTimestamp(valor) {
  const numero = typeof valor === 'string' ? Number(valor) : valor;
  if (!Number.isFinite(numero) || numero <= 0) {
    fallar('El timestamp del evento no es un numero valido.', 'VALIDACION');
  }
  return numero;
}

/**
 * Verifica la firma de un evento de Wompi y devuelve su ficha.
 *
 * Lanza `ErrorWompi` con `codigo: 'FIRMA'` si el checksum no cuadra o si el
 * evento esta fuera de la ventana de tiempo, y con `codigo: 'VALIDACION'` si al
 * cuerpo le falta algo para poder verificar. En los dos casos la respuesta
 * correcta hacia afuera es 400 y no procesar nada.
 *
 * @param {object|string|Buffer} cuerpo Cuerpo del webhook, crudo o ya interpretado.
 * @param {object} opciones
 * @param {string} opciones.secretoEventos Secreto de firma del comercio.
 * @param {object} [opciones.cabeceras] Cabeceras de la peticion.
 * @param {string} [opciones.checksumRecibido] Checksum explicito, si no viene en las cabeceras.
 * @param {number} [opciones.toleranciaSegundos] Ventana permitida frente a la hora del evento.
 *   Con 0 se desactiva la revision de tiempo.
 * @param {number} [opciones.ahoraMs] Hora actual en milisegundos. Se inyecta en pruebas.
 * @returns {object} Ficha del evento: tipo, momento, ambiente y transaccion.
 */
export function verificarFirmaEvento(cuerpo, {
  secretoEventos,
  cabeceras = {},
  checksumRecibido = null,
  toleranciaSegundos = TOLERANCIA_SEGUNDOS,
  ahoraMs = Date.now(),
} = {}) {
  const evento = leerCuerpo(cuerpo);

  if (!Number.isFinite(toleranciaSegundos) || toleranciaSegundos < 0) {
    fallar('La tolerancia de tiempo debe ser un numero de segundos mayor o igual a cero.', 'VALIDACION');
  }

  const recibido = typeof checksumRecibido === 'string' && checksumRecibido.trim() !== ''
    ? checksumRecibido.trim()
    : tomarChecksum(evento, cabeceras);

  if (!recibido) {
    fallar('El evento no trae checksum: ni en la cabecera X-Event-Checksum ni en signature.checksum.');
  }
  if (recibido.length !== LARGO_CHECKSUM || !/^[0-9a-f]+$/i.test(recibido)) {
    fallar('El checksum del evento no tiene forma de SHA-256 en hexadecimal.');
  }

  const esperado = calcularFirma(evento, secretoEventos);

  if (!compararEnTiempoConstante(esperado, recibido)) {
    fallar('La firma del evento no coincide. El cuerpo no lo emitio Wompi o fue alterado.');
  }

  const momento = tomarTimestamp(evento.timestamp);

  if (toleranciaSegundos > 0) {
    const ahoraSegundos = Math.floor(ahoraMs / 1000);
    const diferencia = Math.abs(ahoraSegundos - momento);

    if (diferencia > toleranciaSegundos) {
      fallar(
        `El evento esta fuera de la ventana de ${toleranciaSegundos} segundos `
        + `(hace ${diferencia}). Se descarta para que un cuerpo capturado no sirva de nuevo.`,
      );
    }
  }

  const ambiente = tomarValor(evento, 'environment') ?? tomarValor(evento, 'data.transaction.environment') ?? null;
  const identificador = tomarValor(evento, 'data.transaction.id') ?? null;

  return {
    tipo: typeof evento.event === 'string' ? evento.event : null,
    momento,
    ambiente: typeof ambiente === 'string' ? ambiente : null,
    idEvento: typeof evento.sent_at === 'string' ? evento.sent_at : null,
    transaccion: {
      id: typeof identificador === 'string' ? identificador : null,
      estado: tomarValor(evento, 'data.transaction.status') ?? null,
      referencia: tomarValor(evento, 'data.transaction.reference') ?? null,
      montoEnCentavos: Number.isInteger(tomarValor(evento, 'data.transaction.amount_in_cents'))
        ? tomarValor(evento, 'data.transaction.amount_in_cents')
        : null,
      moneda: tomarValor(evento, 'data.transaction.currency') ?? null,
    },
    crudo: evento,
  };
}
