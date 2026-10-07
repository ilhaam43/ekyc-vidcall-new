import { spawn } from 'node:child_process';
import path from 'node:path';
const services = [
  ['ekyc-backend-master/src/server.js', '8080'],
  ['ekyc-vidcall-backend/src/server.js', '5030'],
];
const children = services.map(([file, port]) => spawn(process.execPath, ['--env-file=.env', file], { stdio: 'inherit', env: { ...process.env, PORT: port } }));
children.push(spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], { cwd: 'ekyc-agent-frontend', stdio: 'inherit', env: process.env }));
for (const child of children) child.on('exit', code => { if (code) process.exitCode = code; });
process.on('SIGINT', () => { for (const child of children) child.kill('SIGINT'); });
