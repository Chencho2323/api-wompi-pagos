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

// Verificacion de la firma de los webhooks: nada se da por pagado si el evento
// no viene firmado con el secreto del comercio y dentro de la ventana de tiempo.
export {
  verificarFirmaEvento,
  calcularFirma,
  CABECERA_CHECKSUM,
  TOLERANCIA_SEGUNDOS,
} from './webhooks.js';

// Servidor HTTP con el flujo completo: sesiones, enlaces, estado de la
// transaccion, devoluciones y el webhook firmado. Es la forma corta de
// levantar el flujo sin escribir el pegamento en cada proyecto.
export { crearServidor, MAXIMO_BYTES } from './servidor.js';

export default { VERSION };

// Registro e idempotencia: un evento aplicado una sola vez y una devolucion
// pedida una sola vez, aunque Wompi reintente el aviso o el usuario apriete dos
// veces el boton.
export { abrirRegistro } from './registro.js';
export {
  claveDeEvento,
  procesarEvento,
  solicitarDevolucion,
  saldoDevolvible,
} from './idempotencia.js';
