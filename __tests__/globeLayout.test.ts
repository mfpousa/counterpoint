import {
  fibonacciSphere,
  hashId,
  latLonToVec3,
  layoutLevel,
  lengthOf,
  normalize,
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
});
