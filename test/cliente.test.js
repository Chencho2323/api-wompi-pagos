// Pruebas del cliente HTTP de Wompi.
// El cliente se prueba contra un fetch de mentira: no se hace ninguna llamada
// real. Lo que se verifica es lo que suele romperse en produccion: que la llave
// viaje, que el tiempo de espera se respete, que los fallos transitorios se
// reintenten y que los definitivos no se reintenten.

import test from 'node:test';
import assert from 'node:assert/strict';

import { crearCliente, ErrorWompi, ENTORNOS } from '../src/cliente.js';

/** Respuesta minima con la misma forma que usa el cliente. */
function respuesta(cuerpo, { estado = 200, cabeceras = {} } = {}) {
  return {
    ok: estado >= 200 && estado < 300,
    status: estado,
    headers: { get: (nombre) => cabeceras[nombre.toLowerCase()] ?? null },
    text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo ?? {})),
  };
}

/** fetch de mentira que registra las llamadas y devuelve las respuestas en orden. */
function fetchSecuencial(respuestas) {
  const llamadas = [];
  const impl = async (url, opciones) => {
    llamadas.push({ url, opciones });
    const siguiente = respuestas[llamadas.length - 1];
    if (!siguiente) throw new Error('fetch de prueba sin respuesta preparada');
    if (siguiente instanceof Error) throw siguiente;
    return siguiente;
  };
  return { impl, llamadas };
}

/** Espera que no espera: deja constancia de los milisegundos pedidos. */
function dormirFalso() {
  const esperas = [];
  const dormir = async (ms) => {
    esperas.push(ms);
  };
  return { dormir, esperas };
}

test('arma la URL del entorno y manda la llave en la cabecera', async () => {
  const { impl, llamadas } = fetchSecuencial([respuesta({ data: { id: 'prueba' } })]);
  const cliente = crearCliente({ llave: 'pub_prueba_123', entorno: 'sandbox', fetchImpl: impl });

  const resultado = await cliente.solicitar('/merchants/pub_prueba_123');

  assert.deepEqual(resultado, { data: { id: 'prueba' } });
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].url, `${ENTORNOS.sandbox}/merchants/pub_prueba_123`);
  assert.equal(llamadas[0].opciones.headers.Authorization, 'Bearer pub_prueba_123');
  assert.equal(llamadas[0].opciones.method, 'GET');
  assert.equal(llamadas[0].opciones.body, undefined);
});

test('respeta una direccion base explicita y normaliza la barra inicial', async () => {
  const { impl, llamadas } = fetchSecuencial([respuesta({ data: [] })]);
  const cliente = crearCliente({ fetchImpl: impl, baseUrl: 'https://ejemplo.local/v1', entorno: 'sandbox' });

  await cliente.solicitar('transactions');

  assert.equal(llamadas[0].url, 'https://ejemplo.local/v1/transactions');
});

test('rechaza un entorno desconocido antes de hacer ninguna llamada', () => {
  assert.throws(
    () => crearCliente({ entorno: 'pruebas', fetchImpl: async () => respuesta({}) }),
    (error) => error instanceof ErrorWompi && error.codigo === 'CONFIGURACION',
  );
});

test('serializa el cuerpo como JSON y declara el tipo de contenido', async () => {
  const { impl, llamadas } = fetchSecuencial([respuesta({ data: { id: 'sesion-1' } })]);
  const cliente = crearCliente({ llave: 'prv', fetchImpl: impl });

  await cliente.solicitar('/payment_sources', { metodo: 'POST', cuerpo: { tipo: 'CARD', token: 'tok' } });

  assert.equal(llamadas[0].opciones.method, 'POST');
  assert.equal(llamadas[0].opciones.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(llamadas[0].opciones.body), { tipo: 'CARD', token: 'tok' });
});

test('reintenta un 503 y devuelve el resultado del intento que si respondio', async () => {
  const { impl, llamadas } = fetchSecuencial([
    respuesta({ error: { reason: 'servicio no disponible' } }, { estado: 503 }),
    respuesta({ data: { id: 'ok' } }),
  ]);
  const { dormir, esperas } = dormirFalso();
  const cliente = crearCliente({ fetchImpl: impl, dormir, reintentos: 3, esperaBaseMs: 100 });

  const resultado = await cliente.solicitar('/transactions/abc');

  assert.deepEqual(resultado, { data: { id: 'ok' } });
  assert.equal(llamadas.length, 2);
  assert.deepEqual(esperas, [100]);
});

test('no reintenta un 422: el error es de los datos, no del proveedor', async () => {
  const { impl, llamadas } = fetchSecuencial([
    respuesta({ error: { reason: 'VALIDATION_ERROR', messages: { amount_in_cents: ['no es un entero'] } } }, { estado: 422 }),
  ]);
  const { dormir, esperas } = dormirFalso();
  const cliente = crearCliente({ fetchImpl: impl, dormir, reintentos: 3 });

  await assert.rejects(cliente.solicitar('/transactions', { metodo: 'POST', cuerpo: {} }), (error) => {
    assert.ok(error instanceof ErrorWompi);
    assert.equal(error.estado, 422);
    assert.equal(error.intentos, 1);
    assert.match(error.message, /VALIDATION_ERROR/);
    assert.match(error.message, /no es un entero/);
    return true;
  });

  assert.equal(llamadas.length, 1);
  assert.deepEqual(esperas, []);
});

test('agota los intentos en un fallo de red y reporta cuantos fueron', async () => {
  const fallo = Object.assign(new Error('conexion rechazada'), { name: 'TypeError' });
  const { impl, llamadas } = fetchSecuencial([fallo, fallo, fallo]);
  const { dormir, esperas } = dormirFalso();
  const cliente = crearCliente({ fetchImpl: impl, dormir, reintentos: 3, esperaBaseMs: 10 });

  await assert.rejects(cliente.solicitar('/transactions'), (error) => {
    assert.ok(error instanceof ErrorWompi);
    assert.equal(error.codigo, 'RED');
    assert.equal(error.intentos, 3);
    assert.match(error.message, /conexion rechazada/);
    return true;
  });

  assert.equal(llamadas.length, 3);
  assert.deepEqual(esperas, [10, 20]);
});

test('el tiempo de espera se cuenta como fallo de red y se informa como tal', async () => {
  const agotado = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  const { impl } = fetchSecuencial([agotado, respuesta({ data: { id: 'ok' } })]);
  const { dormir } = dormirFalso();
  const cliente = crearCliente({ fetchImpl: impl, dormir, reintentos: 2, timeoutMs: 50 });

  const resultado = await cliente.solicitar('/transactions/1');

  assert.deepEqual(resultado, { data: { id: 'ok' } });
});

test('el limite de tiempo se traduce a una senal de cancelacion en cada intento', async () => {
  const { impl, llamadas } = fetchSecuencial([respuesta({ data: null })]);
  const cliente = crearCliente({ fetchImpl: impl, timeoutMs: 1_234 });

  await cliente.solicitar('/transactions');

  const senal = llamadas[0].opciones.signal;
  assert.ok(senal, 'cada intento debe llevar su propia senal');
  assert.equal(typeof senal.aborted, 'boolean');
});

test('respeta el Retry-After del servidor cuando lo pide', async () => {
  const { impl } = fetchSecuencial([
    respuesta({ error: { reason: 'demasiadas peticiones' } }, { estado: 429, cabeceras: { 'retry-after': '2' } }),
    respuesta({ data: { id: 'ok' } }),
  ]);
  const { dormir, esperas } = dormirFalso();
  const cliente = crearCliente({ fetchImpl: impl, dormir, reintentos: 2, esperaBaseMs: 10 });

  await cliente.solicitar('/transactions');

  assert.deepEqual(esperas, [2_000]);
});

test('acepta un cuerpo vacio con estado exitoso', async () => {
  const { impl } = fetchSecuencial([respuesta('', { estado: 204 })]);
  const cliente = crearCliente({ fetchImpl: impl });

  assert.equal(await cliente.solicitar('/transactions/1/void', { metodo: 'POST' }), null);
});

test('falla con un error claro si la respuesta exitosa no es JSON', async () => {
  const { impl } = fetchSecuencial([respuesta('no es json', { estado: 200 })]);
  const cliente = crearCliente({ fetchImpl: impl });

  await assert.rejects(cliente.solicitar('/transactions'), (error) => {
    assert.equal(error.codigo, 'RESPUESTA');
    assert.match(error.message, /no es JSON/);
    return true;
  });
});
