// Punto de entrada de la envoltura de la API de Wompi.
// Los modulos de la aplicacion se agregan a esta superficie a medida que
// avanza el proyecto, para que quien la consume tenga un solo lugar de entrada.

import { createRequire } from 'node:module';

const requerir = createRequire(import.meta.url);
const paquete = requerir('../package.json');

/** Version publicada del paquete. Se lee de package.json para no duplicarla. */
export const VERSION = paquete.version;

export default { VERSION };
