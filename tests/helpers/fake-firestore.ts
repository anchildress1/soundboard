// In-memory stand-in for the slice of @google-cloud/firestore the app uses. Tests mock the SDK
// module with it: `vi.mock('@google-cloud/firestore', () => fakeFirestoreModule())`.

type Data = Record<string, unknown>;

export const store = new Map<string, Data>();

let autoId = 0;

export function resetStore(): void {
  store.clear();
  autoId = 0;
}

const clone = <T>(value: T): T => structuredClone(value);

class Snapshot {
  constructor(
    readonly id: string,
    private readonly value: Data | undefined,
  ) {}
  get exists() {
    return this.value !== undefined;
  }
  data() {
    return this.value === undefined ? undefined : clone(this.value);
  }
}

export class DocRef {
  constructor(readonly path: string) {}
  get id() {
    return this.path.split('/').at(-1)!;
  }
  collection(name: string) {
    return new CollectionRef(`${this.path}/${name}`);
  }
  async get() {
    return new Snapshot(this.id, store.get(this.path));
  }
  async set(data: Data) {
    store.set(this.path, clone(data));
  }
  async update(data: Data) {
    const current = store.get(this.path);
    if (!current) throw Object.assign(new Error(`NOT_FOUND: ${this.path}`), { code: 5 });
    store.set(this.path, { ...current, ...clone(data) });
  }
}

class Query {
  constructor(
    readonly path: string,
    private readonly order: { field: string; dir: 'asc' | 'desc' } | null = null,
    private readonly max: number | null = null,
  ) {}
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
    return new Query(this.path, { field, dir }, this.max);
  }
  limit(n: number) {
    return new Query(this.path, this.order, n);
  }
  async get() {
    const depth = this.path.split('/').length + 1;
    let docs = [...store.entries()]
      .filter(([key]) => key.startsWith(`${this.path}/`) && key.split('/').length === depth)
      .map(([key, value]) => new Snapshot(key.split('/').at(-1)!, value));
    if (this.order) {
      const { field, dir } = this.order;
      docs.sort((a, b) => {
        const av = a.data()![field] as number;
        const bv = b.data()![field] as number;
        return dir === 'asc' ? av - bv : bv - av;
      });
    }
    if (this.max !== null) docs = docs.slice(0, this.max);
    return { empty: docs.length === 0, docs };
  }
}

export class CollectionRef extends Query {
  doc(id: string) {
    return new DocRef(`${this.path}/${id}`);
  }
  async add(data: Data) {
    const ref = this.doc(`auto${++autoId}`);
    await ref.set(data);
    return ref;
  }
}

class Transaction {
  get(ref: DocRef) {
    return ref.get();
  }
  set(ref: DocRef, data: Data) {
    store.set(ref.path, clone(data));
  }
  update(ref: DocRef, data: Data) {
    store.set(ref.path, { ...store.get(ref.path), ...clone(data) });
  }
}

export class Firestore {
  constructor(readonly options?: unknown) {}
  collection(name: string) {
    return new CollectionRef(name);
  }
  runTransaction<T>(fn: (tx: Transaction) => Promise<T>) {
    return fn(new Transaction());
  }
}

export function fakeFirestoreModule() {
  return { Firestore };
}
