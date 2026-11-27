// Idempotencia de eventos y devoluciones.
//
// Todo lo que llega de Wompi puede llegar dos veces y nada de lo que sale puede
// salir dos veces. Las dos mitades se resuelven igual: se reserva la llave
// antes de hacer el trabajo y, si la llave ya estaba, no se hace nada. La
// reserva es la que gana la carrera entre dos procesos que atienden el mismo
// aviso al mismo tiempo.
//
//   - Un evento: la llave sale del propio cuerpo del webhook (su checksum, o el
//     tipo con la transaccion y la hora). Si el manejador falla, la reserva se
//     suelta para que el reintento de Wompi si pueda aplicarlo.
//
//   - Una devolucion: la llave es la referencia que pone quien la pide. Si se
//     aprieta dos veces el boton, la segunda respuesta es la misma ficha, sin
//     una segunda llamada a Wompi.
//
// La plata no se toca dos veces por un reintento del proveedor.

import { ErrorWompi } from './cliente.js';
import { abrirRegistro } from './registro.js';

/** Un estado que se puede volver a intentar sin riesgo: nunca salio de la casa. */
const REINTENTABLE = new Set(['FALLIDA', 'RECHAZADA']);

/** Ruta de devoluciones de una transaccion. */
function rutaDevoluciones(transaccion) {
  return `/transactions/${encodeURIComponent(transaccion)}/refunds`;
}

/** Falla con el codigo de validacion: el problema esta en los datos, no en Wompi. */
function exigir(condicion, mensaje) {
  if (!condicion) {
    throw new ErrorWompi(mensaje, { codigo: 'VALIDACION' });
  }
}

/** Texto obligatorio y corto, ya recortado. */
function exigirTexto(valor, mensaje) {
  exigir(typeof valor === 'string' && valor.trim() !== '', mensaje);
  return valor.trim();
}

/**
 * Llave de idempotencia de un evento.
 *
 * Manda el checksum del cuerpo firmado: dos entregas del mismo aviso traen el
 * mismo y no hay forma de que colisione con otro. Cuando la ficha no lo trae
 * (por ejemplo, si se armo a mano desde un evento ya interpretado), se usa el
 * tipo con la transaccion y la hora, que distingue un cambio de estado del
 * siguiente.
 *
 * @param {object} evento Ficha devuelta por `verificarFirmaEvento` o el cuerpo crudo.
 * @returns {string} Llave estable para el mismo aviso.
 */
export function claveDeEvento(evento) {
  if (!evento || typeof evento !== 'object') {
    throw new ErrorWompi('Hace falta el evento para calcular su llave.', { codigo: 'VALIDACION' });
  }

  const checksum = evento.checksum ?? evento.crudo?.signature?.checksum ?? null;
  if (typeof checksum === 'string' && checksum.trim() !== '') {
    return checksum.trim().toLowerCase();
  }

  const tipo = typeof evento.tipo === 'string' ? evento.tipo : 'evento';
  const transaccion = evento.transaccion?.id ?? 'sin-transaccion';
  const momento = evento.momento ?? evento.timestamp ?? 'sin-hora';

  return `${tipo}:${transaccion}:${momento}`;
}

/**
 * Aplica un evento una sola vez.
 *
 * Reserva la llave, llama al manejador y deja la marca puesta. Si la llave ya
 * estaba reservada, devuelve `duplicado: true` sin llamar al manejador: ese es
 * el reintento de Wompi y responder 200 es lo correcto, porque el trabajo ya
 * estaba hecho.
 *
 * Si el manejador lanza, la reserva se suelta y el error sube tal cual. Asi el
 * reintento del proveedor encuentra la puerta abierta y vuelve a intentar.
 *
 * @param {object} evento Ficha de `verificarFirmaEvento`.
 * @param {object} opciones
 * @param {object} opciones.registro Registro abierto con `abrirRegistro`.
 * @param {Function} opciones.manejador Recibe el evento y hace el trabajo real.
 * @param {string} [opciones.clave] Llave explicita, si el llamador ya la tiene.
 * @returns {Promise<object>} `{ clave, duplicado, aplicado, resultado }`.
 */
export async function procesarEvento(evento, { registro, manejador, clave } = {}) {
  exigir(registro && typeof registro.marcarEvento === 'function', 'Hace falta el registro de eventos.');
  exigir(typeof manejador === 'function', 'Hace falta el manejador que aplica el evento.');

  const llave = clave ?? claveDeEvento(evento);

  const nueva = registro.marcarEvento(llave, {
    tipo: evento?.tipo ?? null,
    transaccion: evento?.transaccion?.id ?? null,
    estado: evento?.transaccion?.estado ?? null,
    referencia: evento?.transaccion?.referencia ?? null,
  });

  if (!nueva) {
    return { clave: llave, duplicado: true, aplicado: false, resultado: null };
  }

  try {
    const resultado = await manejador(evento, { clave: llave });
    return { clave: llave, duplicado: false, aplicado: true, resultado };
  } catch (error) {
    // El trabajo no quedo hecho: se suelta la reserva para que el reintento
    // de Wompi si pueda aplicarlo.
    registro.desmarcarEvento(llave);
    throw error;
  }
}

/** Normaliza la respuesta de Wompi a la ficha que se guarda. */
function leerDevolucion(respuesta) {
  const datos = respuesta?.data;
  if (!datos || typeof datos !== 'object') {
    return { idWompi: null, estado: 'INDETERMINADA' };
  }
  return {
    idWompi: typeof datos.id === 'string' ? datos.id : null,
    estado: typeof datos.status === 'string' ? datos.status.toUpperCase() : 'PENDIENTE',
  };
}

/**
 * Pide una devolucion a Wompi sin poder pedirla dos veces.
 *
 * La referencia es la llave: es de quien cobra y no se repite. Antes de llamar
 * a Wompi se revisa el registro; si ya hay una devolucion con esa referencia se
 * devuelve la ficha guardada con `duplicado: true` y no sale ninguna peticion.
 *
 * Solo se vuelve a intentar cuando la anterior fallo sin haber salido de la
 * casa (`FALLIDA` o `RECHAZADA`). Un estado `INDETERMINADA` es el caso feo: se
 * envio la peticion y no se sabe si Wompi la aplico. Ese no se repite solo; hay
 * que mirar el panel de Wompi antes, porque repetirlo podria devolver la plata
 * dos veces.
 *
 * @param {{solicitar: Function}} cliente Cliente de `crearCliente`.
 * @param {object} registro Registro abierto con `abrirRegistro`.
 * @param {object} pedido
 * @param {string} pedido.transaccion Identificador de la transaccion en Wompi.
 * @param {number} pedido.montoEnCentavos Monto a devolver, entero positivo.
 * @param {string} pedido.referencia Llave propia de la devolucion.
 * @param {string} [pedido.motivo] Nota para la trazabilidad.
 * @param {number} [pedido.montoOriginalEnCentavos] Monto de la transaccion, para
 *   no devolver mas de lo cobrado entre varias devoluciones parciales.
 * @returns {Promise<object>} Ficha de la devolucion, con `duplicado`.
 */
export async function solicitarDevolucion(cliente, registro, pedido = {}) {
  exigir(
    cliente && typeof cliente.solicitar === 'function',
    'Hace falta el cliente de Wompi. Se crea con crearCliente().',
  );
  exigir(registro && typeof registro.devolucion === 'function', 'Hace falta el registro de devoluciones.');

  const transaccion = exigirTexto(
    pedido.transaccion,
    'La transaccion es obligatoria: es la devolucion de un pago concreto.',
  );
  const referencia = exigirTexto(
    pedido.referencia,
    'La referencia de la devolucion es obligatoria; es la llave que evita el doble cobro.',
  );

  const montoEnCentavos = pedido.montoEnCentavos;
  exigir(
    Number.isInteger(montoEnCentavos) && montoEnCentavos > 0,
    'El monto de la devolucion debe ser un entero positivo en centavos.',
  );

  const previa = registro.devolucion(referencia);

  /** Ficha ya guardada, con la forma que devuelve esta funcion. */
  function fichaGuardada(fila, duplicado) {
    return {
      referencia,
      transaccion: fila.transaccion,
      montoEnCentavos: Number(fila.monto_en_centavos),
      estado: String(fila.estado).toUpperCase(),
      idWompi: fila.id_wompi,
      motivo: fila.motivo,
      duplicado,
    };
  }

  if (previa) {
    const estado = String(previa.estado).toUpperCase();

    // Ya salio, ya se aprobo o no se sabe: no se repite.
    if (!REINTENTABLE.has(estado)) {
      return fichaGuardada(previa, true);
    }

    // La anterior no salio de la casa. Se revisa que siga siendo la misma
    // operacion, para no convertir un error de digitacion en otra devolucion.
    exigir(
      previa.transaccion === transaccion && Number(previa.monto_en_centavos) === montoEnCentavos,
      `La referencia ${referencia} ya se uso para otra devolucion `
      + `(${previa.transaccion}, ${previa.monto_en_centavos} centavos). Use una referencia nueva.`,
    );
  }

  revisarTope(registro, {
    transaccion,
    referencia,
    montoEnCentavos,
    montoOriginalEnCentavos: pedido.montoOriginalEnCentavos,
  });

  // Reserva: la devolucion queda anotada como pendiente antes de salir, dentro
  // de una transaccion de la base para que dos procesos no reserven a la vez.
  // Si el proceso se cae a mitad de camino, la proxima corrida encuentra la marca.
  const reservada = registro.enTransaccion(() => {
    const otra = registro.devolucion(referencia);
    if (otra && !REINTENTABLE.has(String(otra.estado).toUpperCase())) {
      return { yaEstaba: true, fila: otra };
    }
    registro.guardarDevolucion({
      referencia,
      transaccion,
      montoEnCentavos,
      estado: 'PENDIENTE',
      idWompi: otra?.id_wompi ?? null,
      motivo: pedido.motivo ?? null,
    });
    return { yaEstaba: false, fila: null };
  });

  if (reservada.yaEstaba) {
    return fichaGuardada(reservada.fila, true);
  }

  let respuesta;
  try {
    respuesta = await cliente.solicitar(rutaDevoluciones(transaccion), {
      metodo: 'POST',
      cuerpo: { amount_in_cents: montoEnCentavos },
    });
  } catch (error) {
    // Un fallo de red o un 5xx deja la duda de si Wompi alcanzo a aplicarla.
    // Un 4xx es seguro: la peticion fue rechazada y no movio plata.
    const dudosa = !(error?.estado >= 400 && error.estado < 500);
    registro.guardarDevolucion({
      referencia,
      transaccion,
      montoEnCentavos,
      estado: dudosa ? 'INDETERMINADA' : 'FALLIDA',
      idWompi: previa?.id_wompi ?? null,
      motivo: error?.message ?? 'fallo al pedir la devolucion',
    });
    throw error;
  }

  const leida = leerDevolucion(respuesta);
  registro.guardarDevolucion({
    referencia,
    transaccion,
    montoEnCentavos,
    estado: leida.estado,
    idWompi: leida.idWompi,
    motivo: pedido.motivo ?? null,
  });

  return {
    referencia,
    transaccion,
    montoEnCentavos,
    estado: leida.estado,
    idWompi: leida.idWompi,
    motivo: pedido.motivo ?? null,
    duplicado: false,
  };
}

/**
 * Revisa que la suma de devoluciones de una transaccion no pase de lo cobrado.
 *
 * Solo se puede revisar cuando el llamador trae el monto original. Sin ese
 * dato se confia en que Wompi rechace el exceso, que es lo que hace.
 */
function revisarTope(registro, { transaccion, referencia, montoEnCentavos, montoOriginalEnCentavos }) {
  if (montoOriginalEnCentavos === undefined || montoOriginalEnCentavos === null) return;

  exigir(
    Number.isInteger(montoOriginalEnCentavos) && montoOriginalEnCentavos > 0,
    'El monto original debe ser un entero positivo en centavos.',
  );

  const yaDevuelto = registro
    .devolucionesDe(transaccion)
    .filter((fila) => fila.referencia !== referencia)
    .filter((fila) => !REINTENTABLE.has(String(fila.estado).toUpperCase()))
    .reduce((suma, fila) => suma + Number(fila.monto_en_centavos), 0);

  exigir(
    yaDevuelto + montoEnCentavos <= montoOriginalEnCentavos,
    `La devolucion pasa de lo cobrado: ${yaDevuelto + montoEnCentavos} de `
    + `${montoOriginalEnCentavos} centavos, contando las anteriores.`,
  );
}

/** Lo que le queda por devolver a una transaccion, segun el registro. */
export function saldoDevolvible(registro, transaccion, montoOriginalEnCentavos) {
  exigir(typeof registro?.devolucionesDe === 'function', 'Hace falta el registro de devoluciones.');
  exigir(
    Number.isInteger(montoOriginalEnCentavos) && montoOriginalEnCentavos > 0,
    'El monto original debe ser un entero positivo en centavos.',
  );

  const devuelto = registro
    .devolucionesDe(exigirTexto(transaccion, 'La transaccion es obligatoria.'))
    .filter((fila) => !REINTENTABLE.has(String(fila.estado).toUpperCase()))
    .reduce((suma, fila) => suma + Number(fila.monto_en_centavos), 0);

  return Math.max(montoOriginalEnCentavos - devuelto, 0);
}

export { abrirRegistro };
