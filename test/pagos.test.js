// Pruebas de las sesiones y los enlaces de pago.
// Igual que el cliente, se prueban contra un cliente de mentira: lo que se
// verifica es el cuerpo que sale hacia Wompi, la ficha que vuelve y que los
// datos invalidos se rechacen antes de gastar una llamada.

import test from 'node:test';
import assert from 'node:assert/strict';

import { crearSesionPago, crearEnlacePago, URL_CHECKOUT } from '../src/pagos.js';
import { ErrorWompi } from '../src/cliente.js';

/** Cliente de mentira que registra las peticiones y responde lo que se le diga. */
function clienteFalso(respuesta) {
  const peticiones = [];
  return {
    peticiones,
    async solicitar(ruta, opciones) {
      peticiones.push({ ruta, opciones });
      if (respuesta instanceof Error) throw respuesta;
      return respuesta;
    },
  };
}

/** Ficha de sesion como la devuelve Wompi, recortada a los campos que se usan. */
function sesionDeWompi(id = 'ps_123') {
  return { data: { id, status: 'OPEN', amount_in_cents: 250000, currency: 'COP' } };
}

test('crea la sesion de pago con el cuerpo que espera Wompi', async () => {
  const cliente = clienteFalso(sesionDeWompi());

  const sesion = await crearSesionPago(cliente, {
    montoEnCentavos: 250_000,
    referencia: 'pedido-1042',
    correoCliente: 'cliente@ejemplo.com',
    descripcion: 'Camisa talla M',
    urlRetorno: 'https://tienda.ejemplo.com/gracias',
  });

  assert.equal(cliente.peticiones.length, 1);
  const { ruta, opciones } = cliente.peticiones[0];
  assert.equal(ruta, '/payment_sessions');
  assert.equal(opciones.metodo, 'POST');
  assert.deepEqual(opciones.cuerpo, {
    amount_in_cents: 250_000,
    currency: 'COP',
    reference: 'pedido-1042',
    expiration_time: 60,
    customer_email: 'cliente@ejemplo.com',
    payment_description: 'Camisa talla M',
    redirect_url: 'https://tienda.ejemplo.com/gracias',
  });

  assert.deepEqual(sesion, {
    id: 'ps_123',
    estado: 'OPEN',
    referencia: 'pedido-1042',
    montoEnCentavos: 250_000,
    moneda: 'COP',
    urlCheckout: `${URL_CHECKOUT}/ps_123`,
    expiraEnMinutos: 60,
  });
});

test('omite los campos opcionales que no se enviaron', async () => {
  const cliente = clienteFalso(sesionDeWompi());

  await crearSesionPago(cliente, { montoEnCentavos: 1_000, referencia: 'ref-min' });

  const cuerpo = cliente.peticiones[0].opciones.cuerpo;
  assert.equal('customer_email' in cuerpo, false);
  assert.equal('payment_description' in cuerpo, false);
  assert.equal('redirect_url' in cuerpo, false);
  assert.equal('payment_method_types' in cuerpo, false);
});

test('normaliza la moneda y los metodos de pago a mayusculas', async () => {
  const cliente = clienteFalso(sesionDeWompi());

  const sesion = await crearSesionPago(cliente, {
    montoEnCentavos: 5_000,
    moneda: 'cop',
    referencia: 'ref-2',
    metodosPago: ['card', ' nequi '],
    expiracionMinutos: 30,
  });

  const cuerpo = cliente.peticiones[0].opciones.cuerpo;
  assert.equal(cuerpo.currency, 'COP');
  assert.deepEqual(cuerpo.payment_method_types, ['CARD', 'NEQUI']);
  assert.equal(cuerpo.expiration_time, 30);
  assert.equal(sesion.moneda, 'COP');
  assert.equal(sesion.expiraEnMinutos, 30);
});

test('rechaza un monto que no sea entero positivo sin llamar a Wompi', async () => {
  for (const monto of [0, -100, 12.5, '250000', undefined]) {
    const cliente = clienteFalso(sesionDeWompi());
    await assert.rejects(
      crearSesionPago(cliente, { montoEnCentavos: monto, referencia: 'ref' }),
      (error) => error instanceof ErrorWompi && error.codigo === 'VALIDACION',
    );
    assert.equal(cliente.peticiones.length, 0);
  }
});

test('rechaza una moneda que Wompi no maneja', async () => {
  const cliente = clienteFalso(sesionDeWompi());

  await assert.rejects(
    crearSesionPago(cliente, { montoEnCentavos: 1_000, moneda: 'EUR', referencia: 'ref' }),
    /moneda/i,
  );
  assert.equal(cliente.peticiones.length, 0);
});

test('rechaza una referencia vacia o demasiado larga', async () => {
  const cliente = clienteFalso(sesionDeWompi());

  await assert.rejects(crearSesionPago(cliente, { montoEnCentavos: 1_000, referencia: '   ' }), /referencia/i);
  await assert.rejects(
    crearSesionPago(cliente, { montoEnCentavos: 1_000, referencia: 'x'.repeat(256) }),
    /255/,
  );
  assert.equal(cliente.peticiones.length, 0);
});

test('rechaza un correo con forma invalida', async () => {
  const cliente = clienteFalso(sesionDeWompi());

  await assert.rejects(
    crearSesionPago(cliente, {
      montoEnCentavos: 1_000,
      referencia: 'ref',
      correoCliente: 'cliente-arroba-ejemplo',
    }),
    /correo/i,
  );
  assert.equal(cliente.peticiones.length, 0);
});

test('rechaza una direccion de retorno que no sea http o https', async () => {
  const cliente = clienteFalso(sesionDeWompi());

  await assert.rejects(
    crearSesionPago(cliente, {
      montoEnCentavos: 1_000,
      referencia: 'ref',
      urlRetorno: 'javascript:alert(1)',
    }),
    /retorno/i,
  );
});

test('falla si Wompi responde sin el bloque de datos', async () => {
  const cliente = clienteFalso({});

  await assert.rejects(
    crearSesionPago(cliente, { montoEnCentavos: 1_000, referencia: 'ref' }),
    (error) => error instanceof ErrorWompi && error.codigo === 'RESPUESTA',
  );
});

test('deja la direccion del checkout en nulo si la respuesta no trae identificador', async () => {
  const cliente = clienteFalso({ data: { status: 'OPEN' } });

  const sesion = await crearSesionPago(cliente, { montoEnCentavos: 1_000, referencia: 'ref' });

  assert.equal(sesion.id, null);
  assert.equal(sesion.urlCheckout, null);
});

test('respeta un checkout alterno, que es lo que se usa en pruebas', async () => {
  const cliente = clienteFalso(sesionDeWompi('ps_9'));

  const sesion = await crearSesionPago(cliente, {
    montoEnCentavos: 1_000,
    referencia: 'ref',
    baseUrlCheckout: 'https://checkout.local/l/',
  });

  assert.equal(sesion.urlCheckout, 'https://checkout.local/l/ps_9');
});

test('crea el enlace de pago con nombre, referencia y opciones', async () => {
  const cliente = clienteFalso({ data: { id: 'pl_77', status: 'ACTIVE' } });

  const enlace = await crearEnlacePago(cliente, {
    nombre: 'Cuota de mantenimiento',
    descripcion: 'Noviembre',
    montoEnCentavos: 480_000,
    referencia: 'cuota-2026-11',
    unSoloUso: true,
    cobrarEnvio: true,
  });

  const { ruta, opciones } = cliente.peticiones[0];
  assert.equal(ruta, '/payment_links');
  assert.equal(opciones.metodo, 'POST');
  assert.deepEqual(opciones.cuerpo, {
    name: 'Cuota de mantenimiento',
    description: 'Noviembre',
    amount_in_cents: 480_000,
    currency: 'COP',
    reference: 'cuota-2026-11',
    single_use: true,
    collect_shipping: true,
  });

  assert.deepEqual(enlace, {
    id: 'pl_77',
    estado: 'ACTIVE',
    referencia: 'cuota-2026-11',
    nombre: 'Cuota de mantenimiento',
    montoEnCentavos: 480_000,
    moneda: 'COP',
    unSoloUso: true,
    cobrarEnvio: true,
    urlCheckout: `${URL_CHECKOUT}/pl_77`,
  });
});

test('el enlace de pago exige nombre y usa las opciones en falso por defecto', async () => {
  const sinNombre = clienteFalso({ data: { id: 'pl_1' } });
  await assert.rejects(
    crearEnlacePago(sinNombre, { montoEnCentavos: 1_000, referencia: 'ref' }),
    /nombre/i,
  );
  assert.equal(sinNombre.peticiones.length, 0);

  const cliente = clienteFalso({ data: { id: 'pl_1' } });
  const enlace = await crearEnlacePago(cliente, { nombre: 'Cobro', montoEnCentavos: 1_000, referencia: 'ref' });

  const cuerpo = cliente.peticiones[0].opciones.cuerpo;
  assert.equal(cuerpo.single_use, false);
  assert.equal(cuerpo.collect_shipping, false);
  assert.equal(enlace.unSoloUso, false);
});

test('el enlace de pago rechaza opciones que no son booleanas', async () => {
  const cliente = clienteFalso({ data: { id: 'pl_1' } });

  await assert.rejects(
    crearEnlacePago(cliente, { nombre: 'Cobro', montoEnCentavos: 1_000, referencia: 'ref', unSoloUso: 'si' }),
    /verdadero o falso/i,
  );
  assert.equal(cliente.peticiones.length, 0);
});

test('exige un cliente con la operacion de solicitar', async () => {
  await assert.rejects(crearSesionPago({}, { montoEnCentavos: 1_000, referencia: 'ref' }), /crearCliente/);
  await assert.rejects(crearEnlacePago(null, { nombre: 'Cobro' }), /crearCliente/);
});
