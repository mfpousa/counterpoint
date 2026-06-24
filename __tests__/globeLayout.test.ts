import {
  cross,
  dot,
  fibonacciSphere,
  greatCircleArc,
  greatCirclePoint,
  hashId,
  latLonToVec3,
  layoutLevel,
  lengthOf,
  normalize,
  tangentRing,
  type Vec3,
} from "../src/lib/globeLayout";

const expectUnit = (v: Vec3) => expect(lengthOf(v)).toBeCloseTo(1, 9);

describe("globeLayout (pure procedural placement)", () => {
  it("hashId is deterministic and an unsigned 32-bit int", () => {
    expect(hashId("europe")).toBe(hashId("europe"));
    expect(hashId("europe")).not.toBe(hashId("asia"));
    expect(hashId("")).toBeGreaterThanOrEqual(0);
    expect(hashId("anything")).toBeLessThanOrEqual(0xffffffff);
  });

  it("fibonacciSphere returns n unit-length points", () => {
    expect(fibonacciSphere(0)).toEqual([]);
    const one = fibonacciSphere(1);
    expect(one).toHaveLength(1);
    expectUnit(one[0]);
    const many = fibonacciSphere(64);
    expect(many).toHaveLength(64);
    for (const p of many) expectUnit(p);
  });

  it("fibonacciSphere is deterministic and seed-rotatable", () => {
    expect(fibonacciSphere(20)).toEqual(fibonacciSphere(20));
    expect(fibonacciSphere(20, 1)).not.toEqual(fibonacciSphere(20, 0));
  });

  it("layoutLevel places every id on the unit sphere, order-independent", () => {
    const ids = ["es", "fr", "de", "it"];
    const a = layoutLevel(ids, "europe");
    expect([...a.keys()].sort()).toEqual([...ids].sort());
    for (const v of a.values()) expectUnit(v);
    // Shuffling the input must yield identical positions per id (sorted assignment).
    const b = layoutLevel(["de", "it", "es", "fr"], "europe");
    for (const id of ids) expect(b.get(id)).toEqual(a.get(id));
  });

  it("layoutLevel orientation differs by seedKey so levels look distinct", () => {
    const ids = ["a", "b", "c"];
    const europe = layoutLevel(ids, "europe");
    const asia = layoutLevel(ids, "asia");
    const moved = ids.some(
      (id) => JSON.stringify(europe.get(id)) !== JSON.stringify(asia.get(id)),
    );
    expect(moved).toBe(true);
  });

  it("latLonToVec3 maps poles/equator correctly and stays unit length", () => {
    const north = latLonToVec3(90, 0);
    expect(north.y).toBeCloseTo(1, 9);
    expectUnit(north);
    const origin = latLonToVec3(0, 0);
    expect(origin.x).toBeCloseTo(1, 9);
    expect(origin.y).toBeCloseTo(0, 9);
    expectUnit(latLonToVec3(12.34, -56.78));
  });

  it("normalize returns a unit vector", () => {
    expectUnit(normalize({ x: 3, y: 0, z: 4 }));
    expect(normalize({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("cross follows the right-hand rule", () => {
    const z = cross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(z.x).toBeCloseTo(0, 9);
    expect(z.y).toBeCloseTo(0, 9);
    expect(z.z).toBeCloseTo(1, 9);
  });

  it("tangentRing fans unit dirs in a tight ring around the centre", () => {
    const center: Vec3 = latLonToVec3(40, -3); // somewhere over Spain-ish
    expect(tangentRing(center, 1)).toEqual([normalize(center)]);
    const ring = tangentRing(center, 6);
    expect(ring).toHaveLength(6);
    const c = normalize(center);
    for (const p of ring) {
      expectUnit(p);
      // Each stays close to the centre (small angular spread → high dot product).
      const d = p.x * c.x + p.y * c.y + p.z * c.z;
      expect(d).toBeGreaterThan(0.9);
    }
  });

  it("dot matches the algebraic definition", () => {
    expect(dot({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 })).toBe(32);
    expect(dot({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBe(0);
  });
});

describe("greatCircleArc (tension-tie geometry)", () => {
  const pt = (buf: Float32Array, i: number): Vec3 => ({
    x: buf[i * 3],
    y: buf[i * 3 + 1],
    z: buf[i * 3 + 2],
  });

  it("returns segments+1 points and lands ON each endpoint at baseRadius", () => {
    const a = latLonToVec3(50, 30); // Ukraine-ish
    const b = latLonToVec3(35, 38); // far enough to bow
    const seg = 32;
    const buf = greatCircleArc(a, b, seg, 1.05, 0.2);
    expect(buf).toHaveLength((seg + 1) * 3);
    // Endpoints sit on the base sphere, in the endpoint DIRECTIONS (lift is 0 at t=0,1).
    const first = pt(buf, 0);
    const last = pt(buf, seg);
    expect(lengthOf(first)).toBeCloseTo(1.05, 5);
    expect(lengthOf(last)).toBeCloseTo(1.05, 5);
    expect(dot(normalize(first), normalize(a))).toBeCloseTo(1, 5);
    expect(dot(normalize(last), normalize(b))).toBeCloseTo(1, 5);
  });

  it("bows OUTWARD at the midpoint (mid radius exceeds the endpoints)", () => {
    const a = latLonToVec3(0, -80);
    const b = latLonToVec3(0, 80); // wide span → tall bow
    const seg = 40;
    const buf = greatCircleArc(a, b, seg, 1.0, 0.3);
    const mid = lengthOf(pt(buf, seg / 2));
    expect(mid).toBeGreaterThan(1.0);
    expect(lengthOf(pt(buf, 0))).toBeCloseTo(1.0, 5);
  });

  it("with zero lift, every sample stays on the base sphere", () => {
    const a = latLonToVec3(10, 10);
    const b = latLonToVec3(-20, 60);
    const buf = greatCircleArc(a, b, 24, 1.0, 0);
    for (let i = 0; i <= 24; i++) expect(lengthOf(pt(buf, i))).toBeCloseTo(1.0, 5);
  });

  it("handles (near-)identical endpoints without NaNs", () => {
    const a = latLonToVec3(12, 34);
    const buf = greatCircleArc(a, a, 8, 1.02, 0.2);
    for (let i = 0; i < buf.length; i++) expect(Number.isFinite(buf[i])).toBe(true);
  });

  it("greatCirclePoint rides the same arc: endpoints at t=0/1, bows at t=0.5", () => {
    const a = latLonToVec3(0, -70);
    const b = latLonToVec3(0, 70);
    const p0 = greatCirclePoint(a, b, 0, 1.05, 0.3);
    const p1 = greatCirclePoint(a, b, 1, 1.05, 0.3);
    const pm = greatCirclePoint(a, b, 0.5, 1.05, 0.3);
    // Ends sit on the base sphere, in the endpoint directions.
    expect(lengthOf(p0)).toBeCloseTo(1.05, 5);
    expect(lengthOf(p1)).toBeCloseTo(1.05, 5);
    expect(dot(normalize(p0), normalize(a))).toBeCloseTo(1, 5);
    expect(dot(normalize(p1), normalize(b))).toBeCloseTo(1, 5);
    // Midpoint bows OUTWARD past the base radius.
    expect(lengthOf(pm)).toBeGreaterThan(1.05);
  });

  it("greatCirclePoint matches greatCircleArc at the sampled t", () => {
    const a = latLonToVec3(40, 30);
    const b = latLonToVec3(-10, 60);
    const seg = 20;
    const buf = greatCircleArc(a, b, seg, 1.02, 0.25);
    const i = 7;
    const p = greatCirclePoint(a, b, i / seg, 1.02, 0.25);
    expect(p.x).toBeCloseTo(buf[i * 3], 5);
    expect(p.y).toBeCloseTo(buf[i * 3 + 1], 5);
    expect(p.z).toBeCloseTo(buf[i * 3 + 2], 5);
  });
});
