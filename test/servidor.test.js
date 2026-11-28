// Pruebas del servidor HTTP del flujo de pago.
//
// Se levanta el servidor en un puerto libre y se le habla por HTTP, igual que
// un cliente de verdad. El cliente de Wompi es de mentira y el registro va en
// memoria, asi que no se toca la red de afuera ni queda ningun archivo. Se usa
// `node:http` y no `fetch` porque `fetch` respeta el proxy del entorno y en una
// maquina con proxy puesto no llegaria a 127.0.0.1.
//
// Lo que se comprueba es lo que puede romperse en produccion: que cada ruta
// arme la llamada correcta, que los errores salgan con el estado HTTP que les
// toca, que el webhook con firma mala se rechace y que el evento repetido no se
// aplique dos veces.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';

import { crearServidor } from '../src/servidor.js';
import { abrirRegistro } from '../src/registro.js';
import { ErrorWompi } from '../src/cliente.js';

const SECRETO = 'secreto-de-eventos-de-prueba';
const AHORA_MS = Date.UTC(2026, 10, 28, 15, 30, 0);
const AHORA_S = Math.floor(AHORA_MS / 1000);

/** Cliente de Wompi de mentira: registra la peticion y responde lo que se le diga. */
function clienteFalso(respuesta) {
  const peticiones = [];
  return {
    peticiones,
    async solicitar(ruta, opciones) {
      peticiones.push({ ruta, opciones });
      if (respuesta instanceof Error) throw respuesta;
      return typeof respuesta === 'function' ? respuesta(ruta, opciones) : respuesta;
    },
  };
}

/** Levanta el servidor con las piezas dadas y devuelve la direccion y el cierre. */
async function levantar({ cliente, registro = abrirRegistro(), manejador } = {}) {
  const app = crearServidor({
    cliente,
    registro,
    secretoEventos: SECRETO,
    manejador,
    ahora: () => AHORA_MS,
  });
  const { url, puerto } = await app.escuchar(0);
  return { url, puerto, app, registro };
}

/** Evento de Wompi con la forma real, recortado a los campos que se usan. */
function eventoDeWompi({ timestamp = AHORA_S, id = '1234-5678-9012' } = {}) {
  return {
    event: 'transaction.updated',
    data: {
      transaction: {
        id,
        status: 'APPROVED',
        reference: 'pedido-1042',
        amount_in_cents: 250_000,
        currency: 'COP',
        environment: 'test',
      },
    },
    environment: 'test',
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      checksum: '',
    },
    timestamp,
    sent_at: '2026-11-28T15:29:50.000Z',
  };
}

/** Firma el evento con la regla de Wompi, sin pasar por el codigo bajo prueba. */
function eventoFirmado(opciones) {
  const evento = eventoDeWompi(opciones);
  const valores = evento.signature.properties.map((ruta) => {
    return ruta.split('.').reduce((actual, parte) => actual[parte], evento.data);
  });
  valores.push(String(evento.timestamp));
  valores.push(SECRETO);
  evento.signature.checksum = createHash('sha256').update(valores.join(''), 'utf8').digest('hex');
  return evento;
}

/** Peticion HTTP contra el servidor de pruebas. Devuelve estado y cuerpo ya interpretado. */
function pedir(url, ruta, { metodo = 'GET', cuerpo, cabeceras = {} } = {}) {
  const destino = new URL(ruta, url);
  const texto = cuerpo === undefined ? null : JSON.stringify(cuerpo);
  const cabecerasFinales = { ...cabeceras };
  if (texto !== null) {
    cabecerasFinales['Content-Type'] = 'application/json';
    cabecerasFinales['Content-Length'] = Buffer.byteLength(texto);
  }

  return new Promise((resolver, rechazar) => {
    const peticion = request(
      {
        host: destino.hostname,
        port: destino.port,
        path: `${destino.pathname}${destino.search}`,
        method: metodo,
        headers: cabecerasFinales,
      },
      (respuesta) => {
        const trozos = [];
        respuesta.on('data', (trozo) => trozos.push(trozo));
        respuesta.on('end', () => {
          const crudo = Buffer.concat(trozos).toString('utf8');
          let datos = null;
          try {
            datos = crudo === '' ? null : JSON.parse(crudo);
          } catch {
            datos = crudo;
          }
          resolver({ status: respuesta.statusCode, cuerpo: datos });
        });
      },
    );

    peticion.on('error', rechazar);
    if (texto !== null) peticion.write(texto);
    peticion.end();
  });
}

/** Peticion POST con cuerpo JSON. */
function enviarJson(url, ruta, cuerpo, cabeceras = {}) {
  return pedir(url, ruta, { metodo: 'POST', cuerpo, cabeceras });
}


test('abre una sesion de pago y responde 201 con la ficha', async () => {
  const cliente = clienteFalso({ data: { id: 'ps_123', status: 'OPEN' } });
  const { url, app } = await levantar({ cliente });

  try {
    const respuesta = await enviarJson(url, '/sesiones', {
      montoEnCentavos: 250_000,
      referencia: 'pedido-1042',
      correoCliente: 'cliente@ejemplo.com',
    });

    assert.equal(respuesta.status, 201);
    const ficha = respuesta.cuerpo;
    assert.equal(ficha.id, 'ps_123');
    assert.equal(ficha.urlCheckout, 'https://checkout.wompi.co/l/ps_123');
    assert.equal(cliente.peticiones[0].ruta, '/payment_sessions');
  } finally {
    await app.cerrar();
  }
});

test('rechaza una sesion con monto invalido antes de llamar a Wompi', async () => {
  const cliente = clienteFalso({ data: { id: 'ps_123' } });
  const { url, app } = await levantar({ cliente });

  try {
    const respuesta = await enviarJson(url, '/sesiones', {
      montoEnCentavos: -1,
      referencia: 'pedido-1042',
    });

    assert.equal(respuesta.status, 400);
    const cuerpo = respuesta.cuerpo;
    assert.equal(cuerpo.codigo, 'VALIDACION');
    assert.equal(cliente.peticiones.length, 0);
  } finally {
    await app.cerrar();
  }
});

test('crea un enlace de pago con el cuerpo que espera Wompi', async () => {
  const cliente = clienteFalso({ data: { id: 'pl_9', status: 'ACTIVE' } });
  const { url, app } = await levantar({ cliente });

  try {
    const respuesta = await enviarJson(url, '/enlaces', {
      nombre: 'Cuota de mantenimiento',
      montoEnCentavos: 480_000,
      referencia: 'cuota-2026-11',
      unSoloUso: true,
    });

    assert.equal(respuesta.status, 201);
    const ficha = respuesta.cuerpo;
    assert.equal(ficha.referencia, 'cuota-2026-11');
    assert.equal(ficha.urlCheckout, 'https://checkout.wompi.co/l/pl_9');
    assert.equal(cliente.peticiones[0].opciones.cuerpo.single_use, true);
  } finally {
    await app.cerrar();
  }
});

test('consulta el estado de una transaccion', async () => {
  const cliente = clienteFalso({
    data: {
      id: '1234-5678',
      status: 'APPROVED',
      reference: 'pedido-1042',
      amount_in_cents: 250_000,
      currency: 'COP',
    },
  });
  const { url, app } = await levantar({ cliente });

  try {
    const respuesta = await pedir(url, '/transacciones/1234-5678');
    assert.equal(respuesta.status, 200);
    const ficha = respuesta.cuerpo;
    assert.deepEqual(ficha, {
      id: '1234-5678',
      estado: 'APPROVED',
      referencia: 'pedido-1042',
      montoEnCentavos: 250_000,
      moneda: 'COP',
    });
    assert.equal(cliente.peticiones[0].ruta, '/transactions/1234-5678');
  } finally {
    await app.cerrar();
  }
});

test('una devolucion repetida con la misma referencia sale una sola vez hacia Wompi', async () => {
  const cliente = clienteFalso({ data: { id: 'ref_1', status: 'APPROVED' } });
  const { url, app } = await levantar({ cliente });

  const pedido = {
    transaccion: '1234-5678-9012',
    montoEnCentavos: 250_000,
    referencia: 'devolucion-pedido-1042',
    motivo: 'el cliente devolvio el producto',
  };

  try {
    const primera = await enviarJson(url, '/devoluciones', pedido);
    assert.equal(primera.status, 201);

    const segunda = await enviarJson(url, '/devoluciones', pedido);
    assert.equal(segunda.status, 200);
    const ficha = segunda.cuerpo;
    assert.equal(ficha.duplicado, true);
    assert.equal(cliente.peticiones.length, 1);
  } finally {
    await app.cerrar();
  }
});

test('informa cuanto queda por devolver de una transaccion', async () => {
  const cliente = clienteFalso({ data: { id: 'ref_1', status: 'APPROVED' } });
  const { url, app } = await levantar({ cliente });

  try {
    await enviarJson(url, '/devoluciones', {
      transaccion: '1234-5678-9012',
      montoEnCentavos: 100_000,
      referencia: 'devolucion-parcial',
    });

    const respuesta = await pedir(
      url,
      '/devoluciones/1234-5678-9012/saldo?montoOriginalEnCentavos=250000',
    );
    assert.equal(respuesta.status, 200);
    const cuerpo = respuesta.cuerpo;
    assert.equal(cuerpo.saldoEnCentavos, 150_000);
  } finally {
    await app.cerrar();
  }
});

test('aplica el webhook firmado y no lo repite en el segundo aviso', async () => {
  const cliente = clienteFalso(null);
  const aplicados = [];
  const { url, app, registro } = await levantar({
    cliente,
    manejador: async (evento) => {
      aplicados.push(evento.transaccion.id);
    },
  });

  const evento = eventoFirmado();

  try {
    const primera = await enviarJson(url, '/webhooks/wompi', evento);
    assert.equal(primera.status, 200);
    assert.equal(primera.cuerpo.aplicado, true);

    const segunda = await enviarJson(url, '/webhooks/wompi', evento);
    assert.equal(segunda.status, 200);
    const cuerpo = segunda.cuerpo;
    assert.equal(cuerpo.duplicado, true);
    assert.equal(cuerpo.aplicado, false);

    assert.deepEqual(aplicados, ['1234-5678-9012']);
    assert.equal(registro.totalEventos(), 1);
  } finally {
    await app.cerrar();
  }
});

test('un webhook alterado responde 400 y no toca el registro', async () => {
  const cliente = clienteFalso(null);
  const { url, app, registro } = await levantar({ cliente, manejador: async () => null });

  const evento = eventoFirmado();
  evento.data.transaction.amount_in_cents = 1;

  try {
    const respuesta = await enviarJson(url, '/webhooks/wompi', evento);
    assert.equal(respuesta.status, 400);
    const cuerpo = respuesta.cuerpo;
    assert.equal(cuerpo.codigo, 'FIRMA');
    assert.equal(registro.totalEventos(), 0);
  } finally {
    await app.cerrar();
  }
});

test('si el manejador falla responde 500 y el reintento si aplica el evento', async () => {
  const cliente = clienteFalso(null);
  let intentos = 0;
  const { url, app, registro } = await levantar({
    cliente,
    manejador: async () => {
      intentos += 1;
      if (intentos === 1) throw new Error('la base de pedidos no respondio');
      return 'listo';
    },
  });

  const evento = eventoFirmado();

  try {
    const primera = await enviarJson(url, '/webhooks/wompi', evento);
    assert.equal(primera.status, 500);
    assert.equal(registro.totalEventos(), 0);

    const segunda = await enviarJson(url, '/webhooks/wompi', evento);
    assert.equal(segunda.status, 200);
    assert.equal(segunda.cuerpo.aplicado, true);
    assert.equal(intentos, 2);
  } finally {
    await app.cerrar();
  }
});

test('un fallo de Wompi sale como 502 con el mensaje del proveedor', async () => {
  const cliente = clienteFalso(
    new ErrorWompi('Wompi respondio 503 en /transactions/1', {
      estado: 503,
      ruta: '/transactions/1',
      codigo: 'HTTP',
    }),
  );
  const { url, app } = await levantar({ cliente });

  try {
    const respuesta = await pedir(url, '/transacciones/1');
    assert.equal(respuesta.status, 502);
    const cuerpo = respuesta.cuerpo;
    assert.match(cuerpo.error, /503/);
    assert.equal(cuerpo.codigo, 'HTTP');
  } finally {
    await app.cerrar();
  }
});

test('una ruta desconocida responde 404', async () => {
  const { url, app } = await levantar({ cliente: clienteFalso(null) });

  try {
    const respuesta = await pedir(url, '/nada');
    assert.equal(respuesta.status, 404);
    assert.equal(respuesta.cuerpo.error, 'No existe la ruta GET /nada.');
  } finally {
    await app.cerrar();
  }
});
