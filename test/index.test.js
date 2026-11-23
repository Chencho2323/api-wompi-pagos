// Pruebas del punto de entrada del paquete.
// Verifican que el modulo se cargue y que la version publicada coincida con
// la de package.json, que es la unica fuente de verdad.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import paquetePorDefecto, { VERSION } from '../src/index.js';

test('exporta la version del paquete', async () => {
  const crudo = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const paquete = JSON.parse(crudo);

  assert.equal(VERSION, paquete.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('el export por defecto expone la misma version', () => {
  assert.equal(paquetePorDefecto.VERSION, VERSION);
});
