import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function emptyState() {
  return { schema_version: 1, next_sequence: 1, orders: [], refunds: [], history: [] };
}

export class MemoryRepository {
  constructor(initial = emptyState()) {
    this.state = structuredClone(initial);
  }

  read() { return structuredClone(this.state); }
  replace(next) { this.state = structuredClone(next); }
}

// Atomicidade da gravação + publicação do estado somente após sucesso da persistência.
// Um processo por arquivo; em produção, substituir por transação SQL/índices únicos.
export class FileRepository extends MemoryRepository {
  constructor(path) {
    const absolute = resolve(path);
    let initial = emptyState();
    try {
      initial = JSON.parse(readFileSync(absolute, 'utf8'));
      if (initial.schema_version !== 1 || !Number.isSafeInteger(initial.next_sequence)
        || initial.next_sequence < 1 || !Array.isArray(initial.orders)
        || !Array.isArray(initial.refunds) || !Array.isArray(initial.history)) {
        throw new Error('Arquivo de estado inválido; não será substituído automaticamente.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    super(initial);
    this.path = absolute;
    this.writeCount = 0;
  }

  replace(next) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${++this.writeCount}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      const fd = openSync(temporary, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
    super.replace(next);
  }
}
