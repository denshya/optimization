# optimization

## Optimization Pragmas

Pragmas exist to help easy redundant work for optimizing performance of the code.

- `@hoist` - extracts a following callback to global space or to class instance (if references `this`).
- `@fast_loop` - speeds up loops
- `@fast_path` - Bypasses native C++ call for speed
  - `Object.assign`
  - `Object.keys`
  - `Object.values`
  - `Object.entries`
- `@struct`
- `@int32`

- FastIterator
