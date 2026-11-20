/** Copy only modified branches of this adapter's JSON checkpoint. A read-only
 * poll returns the original object, without JSON encoding or shared writes.
 * The committed state stays immutable until BaseInput queues the new output.
 */
export function checkpointDraft<T extends object>(base: T): { value: T; finish(): T } {
  interface Draft {
    base: Record<PropertyKey, unknown>;
    copy?: Record<PropertyKey, unknown>;
    parent?: Draft;
    key?: PropertyKey;
    children: Map<PropertyKey, Draft>;
    proxy: Record<PropertyKey, unknown>;
  }
  const proxies = new WeakMap<object, Draft>();
  const plain = (value: unknown): value is Record<PropertyKey, unknown> => value !== null && typeof value === 'object'
    && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
  const copy = (node: Draft) => {
    if (node.copy) return;
    node.copy = (Array.isArray(node.base) ? node.base.slice() : { ...node.base }) as Record<PropertyKey, unknown>;
    if (node.parent) { copy(node.parent); node.parent.copy![node.key!] = node.proxy; }
  };
  const make = (value: Record<PropertyKey, unknown>, parent?: Draft, key?: PropertyKey): Draft => {
    const node: Draft = { base: value, children: new Map(), proxy: value, parent, key };
    // Separate mutable targets also allow frozen committed fixtures; their
    // non-writable descriptors must not constrain a private draft.
    const target = Array.isArray(value) ? [] : {};
    node.proxy = new Proxy(target, {
      get(_target, property) {
        const current = (node.copy ?? node.base)[property];
        if (!plain(current) || proxies.has(current)) return current;
        let child = node.children.get(property);
        if (!child || child.base !== current) {
          child = make(current, node, property); node.children.set(property, child);
        }
        return child.proxy;
      },
      set(_target, property, value) {
        const current = (node.copy ?? node.base)[property];
        const incoming = plain(value) ? proxies.get(value) : undefined;
        if (Object.is(current, value) || (incoming && !incoming.copy && current === incoming.base)) return true;
        copy(node); node.copy![property] = value; node.children.delete(property); return true;
      },
      deleteProperty(_target, property) {
        if (!(property in (node.copy ?? node.base))) return true;
        copy(node); delete node.copy![property]; node.children.delete(property); return true;
      },
      has: (_target, property) => property in (node.copy ?? node.base),
      ownKeys: () => Reflect.ownKeys(node.copy ?? node.base),
      getOwnPropertyDescriptor(_target, property) {
        const descriptor = Object.getOwnPropertyDescriptor(node.copy ?? node.base, property);
        if (!descriptor) return undefined;
        return { ...descriptor, configurable: property !== 'length' || !Array.isArray(value), writable: true };
      },
    });
    proxies.set(node.proxy, node); return node;
  };
  const root = make(base as Record<PropertyKey, unknown>);
  const finished = new WeakMap<object, unknown>();
  const finishValue = (value: unknown): unknown => {
    if (!plain(value)) return value;
    const node = proxies.get(value);
    if (node && !node.copy) return node.base;
    const source = node?.copy ?? value;
    if (finished.has(source)) return finished.get(source);
    // New assigned values can themselves contain borrowed draft references.
    const result = (Array.isArray(source) ? [] : {}) as Record<PropertyKey, unknown>;
    finished.set(source, result);
    for (const key of Object.keys(source)) result[key] = node && source[key] === node.base[key]
      ? source[key] : finishValue(source[key]);
    return result;
  };
  return { value: root.proxy as T, finish: () => root.copy ? finishValue(root.proxy) as T : base };
}
