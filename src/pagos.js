// Sesiones de pago y enlaces de pago.
//
// Sobre el cliente HTTP se arman las dos formas de cobrar que ofrece Wompi: la
// sesion de pago, que se usa cuando la tienda arma su propio checkout, y el
// enlace de pago, que se comparte por correo o WhatsApp y abre el checkout de
// Wompi. Las dos reciben un monto en centavos y devuelven una ficha ya
// normalizada, para que quien consume el paquete no tenga que recordar el
// nombre de cada campo de la respuesta.

import { ErrorWompi } from './cliente.js';

/** Direccion publica del checkout. El identificador del cobro se agrega al final. */
export const URL_CHECKOUT = 'https://checkout.wompi.co/l';

/** Monedas que acepta Wompi. Se comparan en mayusculas. */
const MONEDAS = new Set(['COP', 'USD', 'MXN', 'BRL', 'PEN', 'CLP']);

/** Forma simple pero suficiente para descartar un correo mal escrito. */
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Valida un dato y falla con el codigo de configuracion.
 *
 * El error no lleva estado HTTP porque no hubo llamada: el problema esta en lo
 * que se iba a enviar, y quien lo atienda debe corregirlo antes de reintentar.
 */
function exigir(condicion, mensaje) {
  if (!condicion) {
    throw new ErrorWompi(mensaje, { codigo: 'VALIDACION' });
  }
}

/** Revisa lo que comparten las dos operaciones: monto, moneda y referencia. */
function revisarCobro({ montoEnCentavos, moneda, referencia }) {
  exigir(
    Number.isInteger(montoEnCentavos) && montoEnCentavos > 0,
    'El monto debe ser un entero positivo en centavos. Con 250000 se cobran 2500 pesos.',
  );
  exigir(
    typeof moneda === 'string' && MONEDAS.has(moneda.toUpperCase()),
    `La moneda debe ser un codigo ISO de tres letras soportado por Wompi: ${[...MONEDAS].join(', ')}.`,
  );
  exigir(
    typeof referencia === 'string' && referencia.trim() !== '' && referencia.trim().length <= 255,
    'La referencia es obligatoria y no puede pasar de 255 caracteres.',
  );
}

/** Revisa un correo opcional. */
function revisarCorreo(correoCliente) {
  if (correoCliente === undefined || correoCliente === null || correoCliente === '') return;
  exigir(
    typeof correoCliente === 'string' && CORREO.test(correoCliente),
    `El correo del cliente no tiene forma de correo: ${String(correoCliente)}`,
  );
}

/** Revisa una direccion de retorno opcional. */
function revisarUrlRetorno(urlRetorno) {
  if (urlRetorno === undefined || urlRetorno === null || urlRetorno === '') return;
  exigir(
    typeof urlRetorno === 'string' && /^https?:\/\/[^\s]+$/i.test(urlRetorno),
    `La direccion de retorno debe empezar por http o https: ${String(urlRetorno)}`,
  );
}

/** Toma el cuerpo `data` de la respuesta y falla si no viene, para no devolver una ficha vacia. */
function leerDatos(respuesta, que) {
  const datos = respuesta?.data;
  if (!datos || typeof datos !== 'object') {
    throw new ErrorWompi(`Wompi no devolvio los datos de la ${que}.`, { codigo: 'RESPUESTA' });
  }
  return datos;
}

/** El checkout necesita el identificador; si falta, se deja la direccion en nulo. */
function armarUrl(datos, baseUrlCheckout) {
  const id = datos?.id;
  if (typeof id !== 'string' || id.trim() === '') return null;
  const base = String(baseUrlCheckout).replace(/\/+$/, '');
  return `${base}/${id}`;
}

/**
 * Crea una sesion de pago.
 *
 * @param {{solicitar: Function}} cliente Cliente devuelto por `crearCliente`.
 * @param {object} cobro
 * @param {number} cobro.montoEnCentavos Monto en centavos, entero positivo.
 * @param {string} [cobro.moneda] Codigo ISO de la moneda. Por defecto COP.
 * @param {string} cobro.referencia Identificador propio del cobro.
 * @param {string} [cobro.correoCliente] Correo que recibe el comprobante.
 * @param {string} [cobro.descripcion] Texto que ve el comprador en el checkout.
 * @param {string} [cobro.urlRetorno] A donde vuelve el comprador al terminar.
 * @param {number} [cobro.expiracionMinutos] Vigencia de la sesion. Por defecto 60.
 * @param {string[]} [cobro.metodosPago] Tipos de pago admitidos, por ejemplo ['CARD'].
 * @param {string} [cobro.baseUrlCheckout] Checkout alterno, para pruebas.
 * @returns {Promise<object>} Ficha normalizada de la sesion.
 */
export async function crearSesionPago(cliente, cobro = {}) {
  exigir(
    cliente && typeof cliente.solicitar === 'function',
    'Hace falta el cliente de Wompi. Se crea con crearCliente().',
  );

  const {
    montoEnCentavos,
    moneda = 'COP',
    referencia,
    correoCliente,
    descripcion,
    urlRetorno,
    expiracionMinutos = 60,
    metodosPago,
    baseUrlCheckout = URL_CHECKOUT,
  } = cobro;

  revisarCobro({ montoEnCentavos, moneda, referencia });
  revisarCorreo(correoCliente);
  revisarUrlRetorno(urlRetorno);
  exigir(
    Number.isInteger(expiracionMinutos) && expiracionMinutos >= 1,
    'La expiracion debe ser un numero entero de minutos mayor o igual a 1.',
  );

  const cuerpo = {
    amount_in_cents: montoEnCentavos,
    currency: moneda.toUpperCase(),
    reference: referencia.trim(),
    expiration_time: expiracionMinutos,
  };
  if (correoCliente) cuerpo.customer_email = correoCliente;
  if (descripcion) cuerpo.payment_description = descripcion;
  if (urlRetorno) cuerpo.redirect_url = urlRetorno;
  if (Array.isArray(metodosPago) && metodosPago.length > 0) {
    exigir(
      metodosPago.every((metodo) => typeof metodo === 'string' && metodo.trim() !== ''),
      'Los metodos de pago deben venir como una lista de textos no vacios.',
    );
    cuerpo.payment_method_types = metodosPago.map((metodo) => metodo.trim().toUpperCase());
  }

  const respuesta = await cliente.solicitar('/payment_sessions', { metodo: 'POST', cuerpo });
  const datos = leerDatos(respuesta, 'sesion de pago');

  return {
    id: typeof datos.id === 'string' ? datos.id : null,
    estado: datos.status ?? null,
    referencia: cuerpo.reference,
    montoEnCentavos,
    moneda: cuerpo.currency,
    urlCheckout: armarUrl(datos, baseUrlCheckout),
    expiraEnMinutos: expiracionMinutos,
  };
}

/**
 * Crea un enlace de pago, pensado para compartir por correo o mensajeria.
 *
 * @param {{solicitar: Function}} cliente Cliente devuelto por `crearCliente`.
 * @param {object} cobro
 * @param {string} cobro.nombre Nombre del cobro, el que ve el comprador.
 * @param {string} [cobro.descripcion] Detalle del cobro.
 * @param {number} cobro.montoEnCentavos Monto en centavos, entero positivo.
 * @param {string} [cobro.moneda] Codigo ISO de la moneda. Por defecto COP.
 * @param {string} cobro.referencia Identificador propio del cobro.
 * @param {boolean} [cobro.unSoloUso] El enlace se cierra despues del primer pago.
 * @param {boolean} [cobro.cobrarEnvio] Pide direccion de envio al comprador.
 * @param {string} [cobro.baseUrlCheckout] Checkout alterno, para pruebas.
 * @returns {Promise<object>} Ficha normalizada del enlace.
 */
export async function crearEnlacePago(cliente, cobro = {}) {
  exigir(
    cliente && typeof cliente.solicitar === 'function',
    'Hace falta el cliente de Wompi. Se crea con crearCliente().',
  );

  const {
    nombre,
    descripcion,
    montoEnCentavos,
    moneda = 'COP',
    referencia,
    unSoloUso = false,
    cobrarEnvio = false,
    baseUrlCheckout = URL_CHECKOUT,
  } = cobro;

  exigir(
    typeof nombre === 'string' && nombre.trim() !== '',
    'El nombre del enlace de pago es obligatorio.',
  );
  revisarCobro({ montoEnCentavos, moneda, referencia });
  exigir(
    typeof unSoloUso === 'boolean' && typeof cobrarEnvio === 'boolean',
    'Las opciones de un solo uso y de cobro de envio deben ser verdadero o falso.',
  );

  const cuerpo = {
    name: nombre.trim(),
    amount_in_cents: montoEnCentavos,
    currency: moneda.toUpperCase(),
    reference: referencia.trim(),
    single_use: unSoloUso,
    collect_shipping: cobrarEnvio,
  };
  if (descripcion) cuerpo.description = descripcion;

  const respuesta = await cliente.solicitar('/payment_links', { metodo: 'POST', cuerpo });
  const datos = leerDatos(respuesta, 'enlace de pago');

  return {
    id: typeof datos.id === 'string' ? datos.id : null,
    estado: datos.status ?? null,
    referencia: cuerpo.reference,
    nombre: cuerpo.name,
    montoEnCentavos,
    moneda: cuerpo.currency,
    unSoloUso,
    cobrarEnvio,
    urlCheckout: armarUrl(datos, baseUrlCheckout),
  };
}
