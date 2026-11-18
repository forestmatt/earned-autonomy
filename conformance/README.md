# Conformance vectors

`vectors.json` lets another implementation of the earned-autonomy engine check itself, in any language, from JSON alone. Every expected output is what this engine returns today.

## Format

- `configs` holds each config once, by name. A decide case names the one it runs against.
- `decide` cases have `input`, `config`, `state` (trust scope and subscription) and `options` (`now` in ms and a fixed decision `id`). `expect` is the full decision, with the reason chain, levels, binding, message and next step.
- `record` cases start from `scope` and apply each of `steps` in order (an outcome and its options), feeding each result's scope to the next. `expect` has one result per step, the new scope and whether it was demoted.
- `bucket` cases are a `salt` and `key`, and `expect` is the bucket from 0 to 9999 (SPEC.md, Bucketing).

## Passing

Run each case and compare your output with `expect` as JSON. Fields this engine leaves out are absent, not null. Times are fixed, so nothing depends on the clock.

The binding, levels and next step carry the behaviour. Messages are this engine's own words, so an implementation in another language may choose to compare only `decision`, `level`, `mode`, `binding`, `levels` and `next`, and say so.

## Changes

The file is made from `test/conformance.cases.ts` by the engine itself, and a test fails if they drift. A changed expectation is a behaviour change, so its commit says what changed for other implementations.
