// Append-only typed arrays that grow geometrically.
export class Growable {
  constructor(Type, capacity = 1024) {
    this.Type = Type;
    this.data = new Type(capacity);
    this.length = 0;
  }

  push(v) {
    if (this.length === this.data.length) this.#grow(this.length + 1);
    this.data[this.length++] = v;
  }

  pushMany(...vs) {
    if (this.length + vs.length > this.data.length) this.#grow(this.length + vs.length);
    for (const v of vs) this.data[this.length++] = v;
  }

  view() {
    return this.data.subarray(0, this.length);
  }

  #grow(min) {
    let cap = this.data.length * 2;
    while (cap < min) cap *= 2;
    const next = new this.Type(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
}
