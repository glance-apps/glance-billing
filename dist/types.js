// Core types for the GLANCE billing/entitlement engine.
//
// The one type everything hinges on is StatusReading. Its `indeterminate` flag
// encodes the load-bearing distinction the whole engine is built around:
// "we could not find out" is NOT the same as "not entitled", and must never be
// allowed to lock a paying user out. See engine.ts for the trust rules.
export {};
