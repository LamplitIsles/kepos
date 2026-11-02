/** Fixed pre-commit rejection categories, safe to return without remote data. */
export type EnrollmentRejection = "capacity" | "pool" | "route" | "excluded";

export class EnrollmentRejected extends Error {
  constructor(readonly reason: EnrollmentRejection) {
    super({ capacity: "receiver device capacity exhausted", pool: "receiver address pool exhausted", route: "receiver address pool conflicts with a route", excluded: "device already has the excluded address" }[reason]);
  }
}
