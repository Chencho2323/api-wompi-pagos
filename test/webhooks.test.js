// Pruebas de la verificacion de la firma de los webhooks.
//
// Se firma un evento de mentira con la misma regla que usa Wompi y se comprueba
// que pasa. Despues se ataca desde los cuatro lados que importan: cuerpo
// alterado, checksum inventado, evento viejo y evento al que le falta el
// secreto. Si alguno de esos cuatro pasara, la verificacion no serviria de nada.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  calcularFirma,
  verificarFirmaEvento,
  CABECERA_CHECKSUM,
  TOLERANCIA_SEGUNDOS,
} from '../src/webhooks.js';
import { ErrorWompi } from '../src/cliente.js';

const SECRETO = 'secreto-de-eventos-de-prueba';
const AHORA_MS = Date.UTC(2026, 10, 26, 15, 30, 0);
const AHORA_S = Math.floor(AHORA_MS / 1000);

/** Evento con la forma que manda Wompi, recortado a lo que se usa. */
function eventoDeWompi({ timestamp = AHORA_S, monto = 250_000 } = {}) {
  return {
    event: 'transaction.updated',
    data: {
      transaction: {
        id: '1234-5678-9012',
        status: 'APPROVED',
        reference: 'pedido-1042',
        amount_in_cents: monto,
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
    sent_at: '2026-11-26T15:29:50.000Z',
  };
}

/** Firma el evento con el mismo algoritmo, sin pasar por el codigo bajo prueba. */
function firmar(evento, secreto = SECRETO) {
  const valores = evento.signature.properties.map((ruta) => {
    return ruta.split('.').reduce((actual, parte) => actual[parte], evento.data);
  });
  valores.push(String(evento.timestamp));
  valores.push(secreto);
  return createHash('sha256').update(valores.join(''), 'utf8').digest('hex');
}

/** Evento listo para verificar: firmado y con el checksum puesto en el cuerpo. */
function eventoFirmado(opciones = {}) {
  const evento = eventoDeWompi(opciones);
  const checksum = firmar(evento, opciones.secreto ?? SECRETO);
  evento.signature.checksum = checksum;
  return evento;
}

/** Corre la verificacion y devuelve el error, para revisar su codigo. */
function errorDe(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('se esperaba un error y no hubo ninguno');
}

test('acepta un evento bien firmado y devuelve su ficha', () => {
  const evento = eventoFirmado();

  const ficha = verificarFirmaEvento(evento, { secretoEventos: SECRETO, ahoraMs: AHORA_MS });

  assert.equal(ficha.tipo, 'transaction.updated');
  assert.equal(ficha.momento, AHORA_S);
  assert.equal(ficha.ambiente, 'test');
  assert.equal(ficha.idEvento, '2026-11-26T15:29:50.000Z');
  assert.deepEqual(ficha.transaccion, {
    id: '1234-5678-9012',
    estado: 'APPROVED',
    referencia: 'pedido-1042',
    montoEnCentavos: 250_000,
    moneda: 'COP',
  });
  assert.equal(ficha.crudo.event, 'transaction.updated');
});

test('acepta el checksum que llega solo en la cabecera', () => {
  const evento = eventoFirmado();
  const checksum = evento.signature.checksum;
  delete evento.signature.checksum;

  const ficha = verificarFirmaEvento(evento, {
    secretoEventos: SECRETO,
    cabeceras: { [CABECERA_CHECKSUM]: checksum },
    ahoraMs: AHORA_MS,
  });

  assert.equal(ficha.transaccion.id, '1234-5678-9012');
});

test('acepta el cuerpo como texto crudo, que es como llega en la peticion', () => {
  const evento = eventoFirmado();

  const ficha = verificarFirmaEvento(JSON.stringify(evento), {
    secretoEventos: SECRETO,
    ahoraMs: AHORA_MS,
  });

  assert.equal(ficha.transaccion.estado, 'APPROVED');
});

test('acepta el cuerpo como Buffer, que es lo que deja leer el framework', () => {
  const evento = eventoFirmado();

  const ficha = verificarFirmaEvento(Buffer.from(JSON.stringify(evento), 'utf8'), {
    secretoEventos: SECRETO,
    ahoraMs: AHORA_MS,
  });

  assert.equal(ficha.transaccion.id, '1234-5678-9012');
});

test('rechaza un evento al que le cambiaron el monto', () => {
  const evento = eventoFirmado();
  evento.data.transaction.amount_in_cents = 1;

  const error = errorDe(() => verificarFirmaEvento(evento, {
    secretoEventos: SECRETO,
    ahoraMs: AHORA_MS,
  }));

  assert.ok(error instanceof ErrorWompi);
  assert.equal(error.codigo, 'FIRMA');
  assert.match(error.message, /no coincide/);
});

test('rechaza un evento firmado con otro secreto', () => {
  const evento = eventoFirmado({ secreto: 'secreto-de-otro-comercio' });

  const error = errorDe(() => verificarFirmaEvento(evento, {
    secretoEventos: SECRETO,
    ahoraMs: AHORA_MS,
  }));

  assert.equal(error.codigo, 'FIRMA');
});

test('rechaza un checksum inventado', () => {
  const evento = eventoFirmado();
  evento.signature.checksum = 'a'.repeat(64);

  const error = errorDe(() => verificarFirmaEvento(evento, {
    secretoEventos: SECRETO,
    ahoraMs: AHORA_MS,
  }));

  assert.equal(error.codigo, 'FIRMA');
});

test('rechaza un checksum que no tiene forma de SHA-256', () => {
  const evento = eventoFirmado();
  const checksumBueno = evento.signature.checksum;
  evento.signature.checksum = 'firma-corta';

  const error = errorDe(() => verificarFirmaEvento(evento, {
    secretoEventos: SECRETO,
    ahoraMs: AHORA_MS,
  }));

  assert.equal(error.codigo, 'FIRMA');
  assert.match(error.message, /SHA-256/);
  assert.notEqual(checksumBueno, evento.signature.checksum);
});

test('rechaza un evento sin checksum, ni en cabecera ni en el cuerpo', () => {
  const evento = eventoFirmado();
  delete evento.signature.checksum;

  const error = errorDe(() => verificarFirmaEvento(evento, {
    secretoEventos: SECRETO,
    ahoraMs: AHORA_MS,
  }));

  assert.equal(error.codigo, 'FIRMA');
  assert.match(error.message, /checksum/);
});

test('rechaza un evento viejo aunque la firma sea correcta', () => {
  const viejo = eventoFirmado({ timestamp: AHORA_S - TOLERANCIA_SEGUNDOS - 1 });

  const error = errorDe(() => verificarFirmaEvento(viejo, {
    secretoEventos: SECRETO,
    ahoraMs: AHORA_MS,
  }));

  assert.equal(error.codigo, 'FIRMA');
  assert.match(error.message, /ventana/);
});

test('rechaza un evento con fecha en el futuro, mas alla de la ventana', () => {
  const futuro = eventoFirmado({ timestamp: AHORA_S + TOLERANCIA_SEGUNDOS + 60 });

  const error = errorDe(() => verificarFirmaEvento(futuro, {
    secretoEventos: SECRETO,
    ahoraMs: AHORA_MS,
  }));

  assert.equal(error.codigo, 'FIRMA');
});

test('acepta un evento en el borde de la ventana', () => {
  const borde = eventoFirmado({ timestamp: AHORA_S - TOLERANCIA_SEGUNDOS });

  const ficha = verificarFirmaEvento(borde, { secretoEventos: SECRETO, ahoraMs: AHORA_MS });

  assert.equal(ficha.momento, AHORA_S - TOLERANCIA_SEGUNDOS);
});

test('con tolerancia cero no revisa la hora del evento', () => {
  const viejo = eventoFirmado({ timestamp: AHORA_S - 86_400 });

  const ficha = verificarFirmaEvento(viejo, {
    secretoEventos: SECRETO,
    toleranciaSegundos: 0,
    ahoraMs: AHORA_MS,
  });

  assert.equal(ficha.momento, AHORA_S - 86_400);
});

test('rechaza un evento sin la lista de campos firmados', () => {
  const evento = eventoFirmado();
  delete evento.signature.properties;

  const error = errorDe(() => verificarFirmaEvento(evento, {
    secretoEventos: SECRETO,
    ahoraMs: AHORA_MS,
  }));

  assert.equal(error.codigo, 'VALIDACION');
  assert.match(error.message, /signature\.properties/);
});

test('rechaza un evento sin timestamp', () => {
  const evento = eventoFirmado();
  delete evento.timestamp;

  const error = errorDe(() => verificarFirmaEvento(evento, {
    secretoEventos: SECRETO,
    ahoraMs: AHORA_MS,
  }));

  assert.equal(error.codigo, 'VALIDACION');
  assert.match(error.message, /timestamp/);
});

test('rechaza la verificacion sin secreto de eventos', () => {
  const evento = eventoFirmado();

  const error = errorDe(() => verificarFirmaEvento(evento, { ahoraMs: AHORA_MS }));

  assert.equal(error.codigo, 'VALIDACION');
  assert.match(error.message, /secreto/);
});

test('rechaza un cuerpo que no es JSON', () => {
  const error = errorDe(() => verificarFirmaEvento('esto no es json', {
    secretoEventos: SECRETO,
    ahoraMs: AHORA_MS,
  }));

  assert.equal(error.codigo, 'VALIDACION');
});

test('calcularFirma usa los campos que declara el evento, en su orden', () => {
  const evento = eventoDeWompi();
  // Se firman otros campos y con otro orden: la cadena cambia y el resultado
  // tambien. Es la prueba de que no se asume una lista fija.
  evento.signature.properties = ['transaction.reference', 'transaction.id'];

  const conEsosCampos = calcularFirma(evento, SECRETO);
  assert.equal(conEsosCampos, firmar(evento));

  evento.signature.properties = ['transaction.id', 'transaction.reference'];
  assert.notEqual(calcularFirma(evento, SECRETO), conEsosCampos);
});

test('calcularFirma devuelve 64 caracteres hexadecimales', () => {
  const firma = calcularFirma(eventoDeWompi(), SECRETO);

  assert.match(firma, /^[0-9a-f]{64}$/);
});
