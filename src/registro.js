// Registro local de lo que ya se proceso.
//
// Un pago llega dos veces: Wompi reintenta el webhook si la respuesta tarda, y
// el mismo aviso puede entrar por dos rutas al mismo tiempo. Sin memoria, el
// pedido se marca pagado dos veces y al cliente se le despacha doble. Lo mismo
// pasa con una devolucion: si el boton se aprieta dos veces, se devuelve la
// plata dos veces.
//
// Este modulo guarda en SQLite la llave de cada evento aplicado y la de cada
// devolucion pedida. La base es local y vive al lado de la aplicacion; tambien
// se puede usar en memoria, que es lo que hacen las pruebas.
//
// Se usa `node:sqlite`, que viene con Node desde la version 22.5 y no obliga a
// compilar nada nativo.

import { DatabaseSync } from 'node:sqlite';

import { ErrorWompi } from './cliente.js';

/** Esquema. Se aplica con IF NOT EXISTS, asi que abrir dos veces no rompe nada. */
const ESQUEMA = `
  CREATE TABLE IF NOT EXISTS eventos_procesados (
    clave         TEXT PRIMARY KEY,
    tipo          TEXT,
    transaccion   TEXT,
    estado        TEXT,
    referencia    TEXT,
    registrado_en INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devoluciones (
    referencia        TEXT PRIMARY KEY,
    transaccion       TEXT NOT NULL,
    monto_en_centavos INTEGER NOT NULL,
    estado            TEXT NOT NULL,
    id_wompi          TEXT,
    motivo            TEXT,
    actualizado_en    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_devoluciones_transaccion
    ON devoluciones (transaccion);
`;

/**
 * Abre el registro.
 *
 * @param {object} [opciones]
 * @param {string} [opciones.archivo] Ruta del archivo SQLite. Con ':memory:' la
 *   base vive en RAM y desaparece al cerrar, que es lo comodo en pruebas.
 * @param {number} [opciones.ahora] Hora inyectable en milisegundos.
 * @returns {object} Registro con las operaciones de eventos y devoluciones.
 */
export function abrirRegistro({ archivo = ':memory:', ahora = () => Date.now() } = {}) {
  if (typeof archivo !== 'string' || archivo.trim() === '') {
    throw new ErrorWompi('La ruta del registro no puede estar vacia.', { codigo: 'CONFIGURACION' });
  }

  let base;
  try {
    base = new DatabaseSync(archivo);
  } catch (causa) {
    throw new ErrorWompi(`No se pudo abrir el registro en ${archivo}`, {
      codigo: 'CONFIGURACION',
      causa,
    });
  }

  base.exec('PRAGMA journal_mode = WAL;');
  base.exec('PRAGMA busy_timeout = 5000;');
  base.exec(ESQUEMA);

  const sentencias = {
    buscarEvento: base.prepare('SELECT * FROM eventos_procesados WHERE clave = ?'),
    insertarEvento: base.prepare(`
      INSERT OR IGNORE INTO eventos_procesados
        (clave, tipo, transaccion, estado, referencia, registrado_en)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    borrarEvento: base.prepare('DELETE FROM eventos_procesados WHERE clave = ?'),
    contarEventos: base.prepare('SELECT COUNT(*) AS total FROM eventos_procesados'),
    buscarDevolucion: base.prepare('SELECT * FROM devoluciones WHERE referencia = ?'),
    guardarDevolucion: base.prepare(`
      INSERT INTO devoluciones
        (referencia, transaccion, monto_en_centavos, estado, id_wompi, motivo, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (referencia) DO UPDATE SET
        estado = excluded.estado,
        id_wompi = excluded.id_wompi,
        motivo = excluded.motivo,
        actualizado_en = excluded.actualizado_en
    `),
    devolucionesDe: base.prepare('SELECT * FROM devoluciones WHERE transaccion = ? ORDER BY actualizado_en'),
  };

  /** Corre un bloque dentro de una transaccion. Si falla, no queda rastro. */
  function enTransaccion(bloque) {
    base.exec('BEGIN IMMEDIATE');
    try {
      const resultado = bloque();
      base.exec('COMMIT');
      return resultado;
    } catch (error) {
      base.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    archivo,

    /** Hora actual del registro, en milisegundos. */
    ahora: () => ahora(),

    /** Deja el evento marcado. Devuelve false si ya estaba: ese es el duplicado. */
    marcarEvento(clave, { tipo = null, transaccion = null, estado = null, referencia = null } = {}) {
      const cambios = sentencias.insertarEvento.run(
        clave,
        tipo,
        transaccion,
        estado,
        referencia,
        ahora(),
      );
      return cambios.changes > 0;
    },

    /** Quita la marca de un evento. Se usa cuando el manejador fallo y hay que reintentar. */
    desmarcarEvento(clave) {
      sentencias.borrarEvento.run(clave);
    },

    /** Ficha del evento ya procesado, o null. */
    evento(clave) {
      return sentencias.buscarEvento.get(clave) ?? null;
    },

    /** Cuantos eventos quedaron aplicados. Sirve para diagnostico y pruebas. */
    totalEventos() {
      return Number(sentencias.contarEventos.get().total);
    },

    /** Ficha de la devolucion pedida con esa referencia, o null. */
    devolucion(referencia) {
      return sentencias.buscarDevolucion.get(referencia) ?? null;
    },

    /** Devoluciones registradas para una transaccion. */
    devolucionesDe(transaccion) {
      return sentencias.devolucionesDe.all(transaccion);
    },

    /** Guarda o actualiza una devolucion. */
    guardarDevolucion(ficha) {
      sentencias.guardarDevolucion.run(
        ficha.referencia,
        ficha.transaccion,
        ficha.montoEnCentavos,
        ficha.estado,
        ficha.idWompi ?? null,
        ficha.motivo ?? null,
        ahora(),
      );
    },

    /** Corre un bloque atomico. Lo usan los modulos que necesitan todo o nada. */
    enTransaccion,

    /** Cierra la base. Despues de esto el registro no sirve. */
    cerrar() {
      base.close();
    },
  };
}
