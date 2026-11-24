// Cliente HTTP de la API de Wompi.
//
// Se encarga de tres cosas que no conviene repetir en cada llamada: armar la
// URL del entorno, mandar la llave privada en la cabecera de autorizacion y
// sobrevivir a los fallos transitorios. Un pago que se cae porque el proveedor
// devolvio un 503 una vez no es aceptable, y una peticion colgada tampoco:
// por eso cada intento lleva su propio limite de tiempo.

/** Direcciones base de la API segun el entorno. */
export const ENTORNOS = {
  produccion: 'https://production.wompi.co/v1',
  sandbox: 'https://sandbox.wompi.co/v1',
};

/** Estados que vale la pena reintentar: el proveedor esta caido o nos frena. */
const ESTADOS_REINTENTABLES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Error de una llamada a Wompi.
 *
 * Lleva el estado HTTP cuando hubo respuesta y el numero de intentos que se
 * alcanzaron a hacer, para que quien lo atienda pueda decidir si conviene
 * reintentar mas tarde o si el problema es de los datos enviados.
 */
export class ErrorWompi extends Error {
  constructor(mensaje, { estado = null, ruta = null, intentos = 0, codigo = 'HTTP', causa = null } = {}) {
    super(mensaje, causa ? { cause: causa } : undefined);
    this.name = 'ErrorWompi';
    this.estado = estado;
    this.ruta = ruta;
    this.intentos = intentos;
    this.codigo = codigo;
  }
}

/** Espera real entre intentos. Existe como funcion aparte para poder sustituirla en pruebas. */
function dormirDeVerdad(milisegundos) {
  return new Promise((resolver) => {
    setTimeout(resolver, milisegundos);
  });
}

/** Traduce el fallo de transporte a una frase que se pueda leer en un log. */
function describirFallo(causa) {
  if (causa && (causa.name === 'TimeoutError' || causa.name === 'AbortError')) {
    return 'se agoto el tiempo de espera';
  }
  return causa && causa.message ? causa.message : 'fallo de red';
}

/** Extrae el motivo que manda Wompi en el cuerpo del error, sin romperse si viene vacio. */
async function leerDetalle(respuesta, ruta) {
  let texto = '';
  try {
    texto = await respuesta.text();
  } catch {
    return `Wompi respondio ${respuesta.status} en ${ruta}`;
  }

  if (!texto) {
    return `Wompi respondio ${respuesta.status} en ${ruta}`;
  }

  try {
    const cuerpo = JSON.parse(texto);
    const motivo = cuerpo?.error?.reason ?? null;
    const mensajes = cuerpo?.error?.messages;
    const lista = mensajes && typeof mensajes === 'object' ? Object.values(mensajes).flat() : [];
    const partes = [motivo, ...lista].filter((parte) => typeof parte === 'string' && parte.trim() !== '');
    if (partes.length > 0) {
      return `Wompi respondio ${respuesta.status} en ${ruta}: ${partes.join('; ')}`;
    }
  } catch {
    // El cuerpo no era JSON. Se usa el texto crudo, recortado.
  }

  return `Wompi respondio ${respuesta.status} en ${ruta}: ${texto.slice(0, 200)}`;
}

/**
 * Crea un cliente contra la API de Wompi.
 *
 * @param {object} opciones
 * @param {string} [opciones.llave] Llave publica o privada. Si falta, se omiten
 *   las llamadas autenticadas y solo sirven los recursos abiertos.
 * @param {'produccion'|'sandbox'} [opciones.entorno] Entorno por defecto.
 * @param {string} [opciones.baseUrl] Direccion explicita; manda sobre `entorno`.
 * @param {Function} [opciones.fetchImpl] Implementacion de fetch. Se inyecta en pruebas.
 * @param {number} [opciones.timeoutMs] Limite de tiempo por intento, en milisegundos.
 * @param {number} [opciones.reintentos] Intentos totales, contando el primero.
 * @param {number} [opciones.esperaBaseMs] Espera del primer reintento. Se duplica en cada uno.
 * @param {number} [opciones.maxEsperaMs] Tope de la espera entre intentos.
 * @param {Function} [opciones.dormir] Espera sustituible, para las pruebas.
 */
export function crearCliente({
  llave = '',
  entorno = 'sandbox',
  baseUrl = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  reintentos = 3,
  esperaBaseMs = 250,
  maxEsperaMs = 5_000,
  dormir = dormirDeVerdad,
} = {}) {
  const direccionBase = baseUrl ?? ENTORNOS[entorno];

  if (!direccionBase) {
    throw new ErrorWompi(`Entorno desconocido: ${entorno}. Use "produccion" o "sandbox".`, {
      codigo: 'CONFIGURACION',
    });
  }
  if (!Number.isInteger(reintentos) || reintentos < 1) {
    throw new ErrorWompi('El numero de reintentos debe ser un entero mayor o igual a 1.', {
      codigo: 'CONFIGURACION',
    });
  }
  if (typeof fetchImpl !== 'function') {
    throw new ErrorWompi('Hace falta una implementacion de fetch. Node 18 o superior la trae.', {
      codigo: 'CONFIGURACION',
    });
  }

  const totalIntentos = reintentos;

  /** Segundos que pide el servidor en Retry-After, si los pide de forma legible. */
  function esperaPedidaPorServidor(respuesta) {
    const valor = respuesta?.headers?.get?.('retry-after');
    if (!valor) return null;
    const segundos = Number(valor);
    if (!Number.isFinite(segundos) || segundos < 0) return null;
    return Math.min(segundos * 1000, maxEsperaMs);
  }

  /** Espera exponencial: 250, 500, 1000... hasta el tope. */
  function esperaDelIntento(intento) {
    const calculada = esperaBaseMs * 2 ** (intento - 1);
    return Math.min(calculada, maxEsperaMs);
  }

  /**
   * Hace una peticion a la API y devuelve el cuerpo ya interpretado.
   *
   * @param {string} ruta Ruta relativa, con o sin barra inicial.
   * @param {object} [opciones]
   * @param {string} [opciones.metodo] Verbo HTTP.
   * @param {object} [opciones.cuerpo] Objeto que se envia como JSON.
   * @param {object} [opciones.cabeceras] Cabeceras adicionales.
   * @returns {Promise<any>} Cuerpo de la respuesta.
   */
  async function solicitar(ruta, { metodo = 'GET', cuerpo, cabeceras = {} } = {}) {
    const url = `${direccionBase}${ruta.startsWith('/') ? ruta : `/${ruta}`}`;
    const cabecerasBase = { Accept: 'application/json' };

    if (cuerpo !== undefined) cabecerasBase['Content-Type'] = 'application/json';
    if (llave) cabecerasBase.Authorization = `Bearer ${llave}`;

    for (let intento = 1; intento <= totalIntentos; intento += 1) {
      let respuesta;

      try {
        respuesta = await fetchImpl(url, {
          method: metodo,
          headers: { ...cabecerasBase, ...cabeceras },
          body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (causa) {
        const error = new ErrorWompi(
          `No se pudo contactar a Wompi en ${ruta}: ${describirFallo(causa)}`,
          { ruta, intentos: intento, codigo: 'RED', causa },
        );

        if (intento < totalIntentos) {
          await dormir(esperaDelIntento(intento));
          continue;
        }

        throw error;
      }

      if (!respuesta.ok) {
        const mensaje = await leerDetalle(respuesta, ruta);
        const error = new ErrorWompi(mensaje, {
          estado: respuesta.status,
          ruta,
          intentos: intento,
          codigo: 'HTTP',
        });
        const reintentable = ESTADOS_REINTENTABLES.has(respuesta.status) || respuesta.status >= 500;

        if (reintentable && intento < totalIntentos) {
          const pedida = esperaPedidaPorServidor(respuesta);
          await dormir(pedida ?? esperaDelIntento(intento));
          continue;
        }

        throw error;
      }

      const texto = await respuesta.text();
      if (!texto) return null;

      try {
        return JSON.parse(texto);
      } catch (causa) {
        throw new ErrorWompi(`Wompi devolvio una respuesta que no es JSON en ${ruta}`, {
          estado: respuesta.status,
          ruta,
          intentos: intento,
          codigo: 'RESPUESTA',
          causa,
        });
      }
    }

    // Inalcanzable: el bucle sale por retorno o por excepcion.
    throw new ErrorWompi(`Se agotaron los intentos contra ${ruta}`, {
      ruta,
      intentos: totalIntentos,
      codigo: 'RED',
    });
  }

  return { solicitar, entorno, baseUrl: direccionBase };
}
