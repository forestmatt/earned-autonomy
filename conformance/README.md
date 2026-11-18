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

## Config schema

`config.schema.json` is a JSON Schema (draft 2020-12) for the config every case runs against, the engine's `Config` type field for field. Use it to check a config before you load it, or point an editor at it with a `"$schema"` line for completion and inline errors. It's strict, so a misspelt field (`alwaysAks`) is an error rather than silently ignored. Every config in `vectors.json` and every rule pack passes it.

The schema checks shape and ranges. Whether a level is supported by an action, or a gate names a real flag, is the engine's `validateConfig` warnings, and the engine never throws on a bad config (it fails safe and says so in the reason chain).

## Changes

`vectors.json` is made from `test/conformance.cases.ts` by the engine itself, and a test fails if they drift. A changed expectation is a behaviour change, so its commit says what changed for other implementations.

`config.schema.json` is made from `test/config.schema.ts`, and the build fails to typecheck if that schema and the `Config` type drift apart. Regenerate both files with `UPDATE_CONFORMANCE=1`.
