import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ base: process.env.VITE_BASE_PATH || '/', plugins: [react()], server: { proxy: { '/api/v1': 'http://localhost:8080', '/api/v2': 'http://localhost:5030', '/v1': 'http://localhost:5030', '/socket.io': { target: 'http://localhost:5030', ws: true } } }, build: { sourcemap: false } });
