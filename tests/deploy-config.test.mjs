// Guards the Coolify/nixpacks build inputs of this repository.
//
// nixpacks' Node provider installs `nodejs_<major>` from a per-major nixpkgs archive: the
// *package* comes from `NIXPACKS_NODE_VERSION` (or package.json `engines.node`), while the
// *archive* is resolved from `engines.node` alone. Without an `engines.node` declaration the
// archive is the one for nixpacks' default Node 18, and asking for `nodejs_24` out of it fails
// with `error: undefined variable 'nodejs_24'`. Both halves are therefore required: the
// declaration here and the matching `NIXPACKS_NODE_VERSION` on the Coolify application.
//
// vite 7 declares `engines.node: ^20.19.0 || >=22.12.0`, and pnpm skips *optional* dependencies
// whose `engines` the running Node does not satisfy — which silently drops platform bindings
// (e.g. `@rolldown/binding-linux-x64-gnu`) and makes `vite build` fail with a missing module.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json'));
const minimumNode = { major: 22, minor: 12 };

/** nixpacks provisions `pnpm-9_x` for a `lockfileVersion: '9.0'` lockfile. */
const nixpacksPnpmMajor = 9;

/** corepack@0.24.1 (the shim nixpacks installs) cannot execute pnpm 11+ entrypoints. */
const corepack0241MaxMajor = 10;

test('package.json declares engines.node at or above 22.12 (nixpacks archive + vite 7 support)', () => {
  const range = pkg.engines?.node;
  assert.ok(range, 'package.json must declare engines.node');
  const match = String(range).match(/(\d+)\.(\d+)/);
  assert.ok(match, `cannot read a minimum version out of engines.node: ${range}`);
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const ok = major > minimumNode.major || (major === minimumNode.major && minor >= minimumNode.minor);
  assert.ok(ok, `engines.node ${range} is below ${minimumNode.major}.${minimumNode.minor}`);
});

test('the pnpm plan stays consistent with what nixpacks provisions', () => {
  const lockfile = read('../pnpm-lock.yaml');
  const version = Number((lockfile.match(/^lockfileVersion:\s*'?(\d+)/m) ?? [])[1]);
  assert.equal(version, 9, `nixpacks provisions pnpm-9_x for a lockfileVersion 9 lockfile, got ${version}`);
  const pin = pkg.packageManager;
  if (pin) {
    const major = Number(String(pin).split('@')[1]?.split('.')[0]);
    assert.equal(major, nixpacksPnpmMajor, `packageManager ${pin} does not match the provisioned pnpm major`);
    assert.ok(major <= corepack0241MaxMajor, `corepack@0.24.1 cannot execute pnpm ${major}`);
  }
});
