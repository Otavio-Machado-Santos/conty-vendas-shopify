import { FileRepository } from './repository.js';
import { SalesService } from './sales-service.js';
import { createApi } from './http.js';

const port = Number(process.env.PORT ?? 3005);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida.');
const repository = new FileRepository(process.env.DATA_FILE ?? 'data/state.json');
const server = createApi(new SalesService({ repository }));
server.listen(port, '127.0.0.1', () => console.log(`API disponível em http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
