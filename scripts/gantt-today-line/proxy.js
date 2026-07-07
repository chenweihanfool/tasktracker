#!/usr/bin/env node
// Tiny reverse proxy that sits in front of the Vikunja binary so we can inject
// a "today" vertical line into the Gantt view without patching/rebuilding
// Vikunja itself (the official release binary embeds a prebuilt frontend, so
// there is no file to patch post-install). All non-HTML traffic (API calls,
// JS/CSS bundles, websockets) is piped through untouched; only HTML documents
// get the extra <link>/<script> tag appended before </body>.
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PUBLIC_PORT = Number(process.env.GANTT_PROXY_PUBLIC_PORT || 3456);
const INTERNAL_PORT = Number(process.env.GANTT_PROXY_INTERNAL_PORT || 3457);
const INTERNAL_HOST = '127.0.0.1';

const INJECT_CSS_PATH = '/__gantt-today-line.css';
const INJECT_JS_PATH = '/__gantt-today-line.js';
const INJECT_TAG = `<link rel="stylesheet" href="${INJECT_CSS_PATH}"><script src="${INJECT_JS_PATH}" defer></script>`;

const ASSET_FILES = {
	[INJECT_CSS_PATH]: {file: 'inject.css', type: 'text/css; charset=utf-8'},
	[INJECT_JS_PATH]: {file: 'inject.js', type: 'application/javascript; charset=utf-8'},
}

function serveAsset(res, asset) {
	fs.readFile(path.join(__dirname, asset.file), (err, data) => {
		if (err) {
			res.writeHead(500)
			res.end('failed to read injected asset: ' + err.message)
			return
		}
		res.writeHead(200, {'content-type': asset.type, 'cache-control': 'no-cache'})
		res.end(data)
	})
}

const server = http.createServer((req, res) => {
	const asset = ASSET_FILES[req.url]
	if (asset) {
		serveAsset(res, asset)
		return
	}

	// Ask Vikunja for uncompressed responses so HTML injection can safely do a
	// plain string replace instead of having to gunzip/brotli-decode first.
	const headers = {...req.headers}
	delete headers['accept-encoding']

	const proxyReq = http.request(
		{
			host: INTERNAL_HOST,
			port: INTERNAL_PORT,
			path: req.url,
			method: req.method,
			headers,
		},
		(proxyRes) => {
			const contentType = proxyRes.headers['content-type'] || ''

			if (!contentType.includes('text/html')) {
				res.writeHead(proxyRes.statusCode, proxyRes.headers)
				proxyRes.pipe(res)
				return
			}

			const chunks = []
			proxyRes.on('data', (chunk) => chunks.push(chunk))
			proxyRes.on('end', () => {
				let body = Buffer.concat(chunks).toString('utf8')
				body = body.includes('</body>')
					? body.replace('</body>', `${INJECT_TAG}</body>`)
					: body + INJECT_TAG

				const responseHeaders = {...proxyRes.headers}
				delete responseHeaders['transfer-encoding']
				responseHeaders['content-length'] = Buffer.byteLength(body)

				res.writeHead(proxyRes.statusCode, responseHeaders)
				res.end(body)
			})
		},
	)

	proxyReq.on('error', (err) => {
		res.writeHead(502)
		res.end('proxy error: ' + err.message)
	})

	req.pipe(proxyReq)
})

// Pass through upgrade requests (e.g. websockets) unmodified, in case a
// future Vikunja version uses them.
server.on('upgrade', (req, clientSocket, head) => {
	const proxySocket = net.connect(INTERNAL_PORT, INTERNAL_HOST, () => {
		const rawHeaders = Object.entries(req.headers)
			.map(([key, value]) => `${key}: ${value}`)
			.join('\r\n')
		proxySocket.write(`${req.method} ${req.url} HTTP/1.1\r\n${rawHeaders}\r\n\r\n`)
		if (head && head.length) proxySocket.write(head)
		proxySocket.pipe(clientSocket)
		clientSocket.pipe(proxySocket)
	})
	proxySocket.on('error', () => clientSocket.destroy())
})

server.listen(PUBLIC_PORT, () => {
	console.log(`[gantt-today-line proxy] listening on :${PUBLIC_PORT}, forwarding to ${INTERNAL_HOST}:${INTERNAL_PORT}`)
})
