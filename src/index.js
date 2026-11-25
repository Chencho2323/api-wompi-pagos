// Punto de entrada de la envoltura de la API de Wompi.
// Los modulos de la aplicacion se agregan a esta superficie a medida que
// avanza el proyecto, para que quien la consume tenga un solo lugar de entrada.

import { createRequire } from 'node:module';

const requerir = createRequire(import.meta.url);
const paquete = requerir('../package.json');

/** Version publicada del paquete. Se lee de package.json para no duplicarla. */
export const VERSION = paquete.version;

// Cliente HTTP de la API de Wompi: timeouts por intento y reintentos con
// espera exponencial. Es la base sobre la que se arman las operaciones.
export { crearCliente, ErrorWompi, ENTORNOS } from './cliente.js';

// Sesiones de pago y enlaces de pago: arman el cuerpo que espera Wompi y
// devuelven una ficha con el identificador y la direccion del checkout.
export { crearSesionPago, crearEnlacePago, URL_CHECKOUT } from './pagos.js';

export default { VERSION };
