import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const [artifact] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }));
assert.ok(artifact.files.some(file => file.path === 'npm-shrinkwrap.json'), 'Packaged CLI must include its reviewed dependency lock');
assert.ok(artifact.files.some(file => file.path === 'dist/index.js'), 'Packaged CLI must include the built MCP entrypoint');
console.log('  OK -> packaged CLI includes its build and dependency pins');
