// Pruebas de la idempotencia de eventos y devoluciones.
//
// Se ataca desde el lado que importa: el mismo aviso dos veces no puede marcar
// dos veces el pedido, y el mismo boton de devolucion dos veces no puede sacar
// plata dos veces. Tambien se mira el caso contrario, que es el que se olvida:
// si el manejador falla, la reserva tiene que soltarse o el reintento de Wompi
// se pierde para siempre.

import test from 'node:test';
import assert from 'node:assert/strict';

import { abrirRegistro } from '../src/registro.js';
import {
  claveDeEvento,
  procesarEvento,
  solicitarDevolucion,
  saldoDevolvible,
} from '../src/idempotencia.js';
import { ErrorWompi } from '../src/cliente.js';

const AHORA_S = Math.floor(Date.UTC(2026, 11, 1, 15, 0, 0) / 1000);

/** Ficha como la que devuelve verificarFirmaEvento. */
function fichaEvento({ checksum = 'a'.repeat(64), estado = 'APPROVED', momento = AHORA_S } = {}) {
  return {
    tipo: 'transaction.updated',
    momento,
    checksum,
    transaccion: {
      id: '1234-5678-9012',
      estado,
      referencia: 'pedido-1042',
      montoEnCentavos: 250_000,
      moneda: 'COP',
    },
    crudo: { signature: { checksum } },
  };
}

/** Cliente falso que cuenta las llamadas y devuelve lo que se le pida. */
function clienteFalso(respuestas = []) {
  const llamadas = [];
  return {
    llamadas,
    async solicitar(ruta, opciones = {}) {
      llamadas.push({ ruta, opciones });
      const siguiente = respuestas.shift();
      if (siguiente instanceof Error) throw siguiente;
      return siguiente ?? { data: { id: 'ref-1', status: 'PENDING' } };
    },
  };
}

test('el mismo evento dos veces se aplica una sola vez', async () => {
  const registro = abrirRegistro();
  const aplicados = [];
  const manejador = async (evento) => {
    aplicados.push(evento.transaccion.id);
    return { pedido: evento.transaccion.referencia };
  };

  const primera = await procesarEvento(fichaEvento(), { registro, manejador });
  const segunda = await procesarEvento(fichaEvento(), { registro, manejador });

  assert.equal(primera.duplicado, false);
  assert.equal(primera.aplicado, true);
  assert.equal(segunda.duplicado, true);
  assert.equal(segunda.aplicado, false);
  assert.equal(aplicados.length, 1, 'el manejador solo debe correr una vez');
  assert.equal(registro.totalEventos(), 1);

  registro.cerrar();
});

test('un evento con otro estado si se aplica: no es el mismo aviso', async () => {
  const registro = abrirRegistro();
  const aplicados = [];
  const manejador = async (evento) => {
    aplicados.push(evento.transaccion.estado);
  };

  await procesarEvento(fichaEvento({ checksum: 'b'.repeat(64), estado: 'PENDING' }), { registro, manejador });
  await procesarEvento(fichaEvento({ checksum: 'c'.repeat(64), estado: 'APPROVED' }), { registro, manejador });

  assert.deepEqual(aplicados, ['PENDING', 'APPROVED']);
  registro.cerrar();
});

test('si el manejador falla, la reserva se suelta y el reintento si aplica', async () => {
  const registro = abrirRegistro();
  let intentos = 0;

  const manejador = async () => {
    intentos += 1;
    if (intentos === 1) throw new Error('la base del pedido no respondio');
    return 'hecho';
  };

  await assert.rejects(
    () => procesarEvento(fichaEvento(), { registro, manejador }),
    /no respondio/,
  );

  assert.equal(registro.totalEventos(), 0, 'la reserva debe quedar suelta');

  const reintento = await procesarEvento(fichaEvento(), { registro, manejador });

  assert.equal(reintento.aplicado, true);
  assert.equal(intentos, 2);
  registro.cerrar();
});

test('dos entregas simultaneas del mismo evento: una sola aplica', async () => {
  const registro = abrirRegistro();
  let corridas = 0;

  const manejador = async () => {
    corridas += 1;
    await new Promise((resolver) => setTimeout(resolver, 5));
    return 'ok';
  };

  const resultados = await Promise.all([
    procesarEvento(fichaEvento(), { registro, manejador }),
    procesarEvento(fichaEvento(), { registro, manejador }),
  ]);

  assert.equal(corridas, 1);
  assert.equal(resultados.filter((r) => r.aplicado).length, 1);
  assert.equal(resultados.filter((r) => r.duplicado).length, 1);
  registro.cerrar();
});

test('la llave del evento sale del checksum y, si falta, del tipo con la transaccion', () => {
  assert.equal(claveDeEvento(fichaEvento({ checksum: 'ABC'.repeat(21) + 'A' })), ('ABC'.repeat(21) + 'A').toLowerCase());

  const sinChecksum = claveDeEvento({ tipo: 'transaction.updated', momento: 7, transaccion: { id: 'tx-1' } });
  assert.equal(sinChecksum, 'transaction.updated:tx-1:7');

  assert.throws(() => claveDeEvento(null), /Hace falta el evento/);
});

test('procesarEvento exige registro y manejador', async () => {
  await assert.rejects(() => procesarEvento(fichaEvento(), {}), /Hace falta el registro/);
  const registro = abrirRegistro();
  await assert.rejects(() => procesarEvento(fichaEvento(), { registro }), /Hace falta el manejador/);
  registro.cerrar();
});

test('una devolucion se pide una sola vez aunque se apriete dos veces', async () => {
  const registro = abrirRegistro();
  const cliente = clienteFalso([{ data: { id: 'ref-99', status: 'APPROVED' } }]);

  const primera = await solicitarDevolucion(cliente, registro, {
    transaccion: '1234-5678-9012',
    montoEnCentavos: 250_000,
    referencia: 'devolucion-pedido-1042',
    motivo: 'el cliente devolvio el producto',
  });

  const segunda = await solicitarDevolucion(cliente, registro, {
    transaccion: '1234-5678-9012',
    montoEnCentavos: 250_000,
    referencia: 'devolucion-pedido-1042',
    motivo: 'el cliente devolvio el producto',
  });

  assert.equal(primera.duplicado, false);
  assert.equal(primera.estado, 'APPROVED');
  assert.equal(segunda.duplicado, true);
  assert.equal(segunda.idWompi, 'ref-99');
  assert.equal(cliente.llamadas.length, 1, 'la segunda vez no debe salir ninguna peticion');

  const [llamada] = cliente.llamadas;
  assert.equal(llamada.ruta, '/transactions/1234-5678-9012/refunds');
  assert.equal(llamada.opciones.metodo, 'POST');
  assert.deepEqual(llamada.opciones.cuerpo, { amount_in_cents: 250_000 });

  registro.cerrar();
});

test('una devolucion rechazada se puede reintentar con la misma referencia', async () => {
  const registro = abrirRegistro();
  const error = new ErrorWompi('Wompi respondio 422', { estado: 422, codigo: 'HTTP' });
  const cliente = clienteFalso([error, { data: { id: 'ref-2', status: 'APPROVED' } }]);

  const pedido = {
    transaccion: 'tx-1',
    montoEnCentavos: 50_000,
    referencia: 'devolucion-1',
  };

  await assert.rejects(() => solicitarDevolucion(cliente, registro, pedido), /422/);
  assert.equal(registro.devolucion('devolucion-1').estado, 'FALLIDA');

  const segunda = await solicitarDevolucion(cliente, registro, pedido);

  assert.equal(segunda.duplicado, false);
  assert.equal(segunda.estado, 'APPROVED');
  assert.equal(cliente.llamadas.length, 2);

  registro.cerrar();
});

test('un fallo de red deja la devolucion indeterminada y no se reintenta sola', async () => {
  const registro = abrirRegistro();
  const error = new ErrorWompi('No se pudo contactar a Wompi', { codigo: 'RED' });
  const cliente = clienteFalso([error, { data: { id: 'ref-3', status: 'APPROVED' } }]);

  const pedido = { transaccion: 'tx-2', montoEnCentavos: 30_000, referencia: 'devolucion-2' };

  await assert.rejects(() => solicitarDevolucion(cliente, registro, pedido), /contactar a Wompi/);
  assert.equal(registro.devolucion('devolucion-2').estado, 'INDETERMINADA');

  const segunda = await solicitarDevolucion(cliente, registro, pedido);

  assert.equal(segunda.duplicado, true);
  assert.equal(segunda.estado, 'INDETERMINADA');
  assert.equal(cliente.llamadas.length, 1, 'no se puede repetir a ciegas: hay que mirar el panel');

  registro.cerrar();
});

test('la misma referencia no sirve para otra devolucion distinta', async () => {
  const registro = abrirRegistro();
  const cliente = clienteFalso([new ErrorWompi('rechazada', { estado: 400, codigo: 'HTTP' })]);

  await assert.rejects(() => solicitarDevolucion(cliente, registro, {
    transaccion: 'tx-3',
    montoEnCentavos: 20_000,
    referencia: 'devolucion-3',
  }));

  await assert.rejects(
    () => solicitarDevolucion(cliente, registro, {
      transaccion: 'tx-3',
      montoEnCentavos: 90_000,
      referencia: 'devolucion-3',
    }),
    /ya se uso para otra devolucion/,
  );

  registro.cerrar();
});

test('no se puede devolver mas de lo cobrado entre varias parciales', async () => {
  const registro = abrirRegistro();
  const cliente = clienteFalso([
    { data: { id: 'ref-a', status: 'APPROVED' } },
  ]);

  await solicitarDevolucion(cliente, registro, {
    transaccion: 'tx-4',
    montoEnCentavos: 80_000,
    referencia: 'parcial-1',
    montoOriginalEnCentavos: 100_000,
  });

  assert.equal(saldoDevolvible(registro, 'tx-4', 100_000), 20_000);

  await assert.rejects(
    () => solicitarDevolucion(cliente, registro, {
      transaccion: 'tx-4',
      montoEnCentavos: 30_000,
      referencia: 'parcial-2',
      montoOriginalEnCentavos: 100_000,
    }),
    /pasa de lo cobrado/,
  );

  assert.equal(cliente.llamadas.length, 1, 'el exceso se corta antes de llamar a Wompi');
  registro.cerrar();
});

test('una devolucion rechazada no descuenta del saldo', async () => {
  const registro = abrirRegistro();
  const cliente = clienteFalso([new ErrorWompi('rechazada', { estado: 422, codigo: 'HTTP' })]);

  await assert.rejects(() => solicitarDevolucion(cliente, registro, {
    transaccion: 'tx-5',
    montoEnCentavos: 100_000,
    referencia: 'fallida-1',
    montoOriginalEnCentavos: 100_000,
  }));

  assert.equal(saldoDevolvible(registro, 'tx-5', 100_000), 100_000);
  registro.cerrar();
});

test('solicitarDevolucion valida lo que recibe antes de tocar la red', async () => {
  const registro = abrirRegistro();
  const cliente = clienteFalso();

  await assert.rejects(
    () => solicitarDevolucion(cliente, registro, { montoEnCentavos: 1_000, referencia: 'x' }),
    /La transaccion es obligatoria/,
  );
  await assert.rejects(
    () => solicitarDevolucion(cliente, registro, { transaccion: 'tx', montoEnCentavos: 1_000 }),
    /La referencia de la devolucion es obligatoria/,
  );
  await assert.rejects(
    () => solicitarDevolucion(cliente, registro, { transaccion: 'tx', montoEnCentavos: 0, referencia: 'x' }),
    /entero positivo en centavos/,
  );
  await assert.rejects(
    () => solicitarDevolucion(null, registro, { transaccion: 'tx', montoEnCentavos: 1, referencia: 'x' }),
    /Hace falta el cliente de Wompi/,
  );

  assert.equal(cliente.llamadas.length, 0);
  assert.equal(registro.totalEventos(), 0);
  registro.cerrar();
});

test('el registro en archivo sobrevive a cerrarlo y volver a abrirlo', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const carpeta = await mkdtemp(join(tmpdir(), 'registro-wompi-'));
  const archivo = join(carpeta, 'pagos.db');

  try {
    const primero = abrirRegistro({ archivo });
    await procesarEvento(fichaEvento(), { registro: primero, manejador: async () => 'ok' });
    primero.cerrar();

    const segundo = abrirRegistro({ archivo });
    const otraVez = await procesarEvento(fichaEvento(), { registro: segundo, manejador: async () => 'ok' });

    assert.equal(otraVez.duplicado, true, 'la marca tiene que estar en el disco, no solo en RAM');
    assert.equal(segundo.totalEventos(), 1);
    segundo.cerrar();
  } finally {
    await rm(carpeta, { recursive: true, force: true });
  }
});
