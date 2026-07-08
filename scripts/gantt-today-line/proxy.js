#!/usr/bin/env node
// Tiny reverse proxy that sits in front of the Vikunja binary so we can patch
// the Gantt view without patching/rebuilding Vikunja itself (the official
// release binary embeds a prebuilt frontend, so there is no file to patch
// post-install). Two independent transforms happen here:
//  - HTML documents get an extra <link>/<script> tag appended before </body>
//    (see inject.css / inject.js) to draw the "today" vertical line.
//  - The Gantt view's own task-list JSON response gets its tasks reordered,
//    grouping every project's tasks together (see groupTasksByProject below).
// All other traffic (other API calls, JS/CSS bundles, websockets) is piped
// through untouched.
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

// Matches the task-list endpoint Vikunja's frontend calls for a project view
// (see frontend/src/services/taskCollection.ts): "/projects/{id}/tasks" or,
// when the request carries a viewId, "/projects/{id}/views/{viewId}/tasks".
const TASK_LIST_PATH_RE = /^\/api\/v1\/projects\/-?\d+\/(?:views\/\d+\/)?tasks$/;

// The Gantt view is the only one that hardcodes sort_by=[start_date, ...]
// (frontend/src/views/project/helpers/useGanttFilters.ts); List/Table/Kanban
// default to sort_by=[position, id]. Checking for that is how we scope the
// project-grouping reorder to the Gantt view only, leaving other views'
// task order exactly as Vikunja returns it.
//
// axios 1.18.1 (pinned in frontend/package.json) serializes an array-valued
// param as repeated `key[]=` entries by default (no custom paramsSerializer
// is configured in frontend/src/helpers/fetcher.ts) -- verified directly by
// making a real axios request and inspecting the wire format -- so the
// actual query string is `sort_by[]=start_date&sort_by[]=done&sort_by[]=id`,
// NOT `sort_by=start_date`. Checking the bare `sort_by` key here silently
// never matched, so this reorder never actually ran. Check both forms so
// this doesn't quietly break again if that serialization ever changes.
function isGanttTaskListRequest(url) {
	if (!TASK_LIST_PATH_RE.test(url.pathname)) return false
	const sortBy = url.searchParams.getAll('sort_by[]').concat(url.searchParams.getAll('sort_by'))
	return sortBy[0] === 'start_date'
}

// Vikunja's Gantt view has no concept of "group rows by project" -- row
// order for tasks with no parent/child relation to each other is just
// whatever order the API returned them in (see buildGanttTaskTree in
// go-vikunja/vikunja's frontend, which walks `tasks` in Map-insertion
// order for root-level tasks). That order is start_date-ascending, so a
// freshly created task with no start_date sorts as if dated year 1 and
// floats to the very top, nowhere near its sibling tasks in the same
// project. Grouping the JSON array by project_id here -- before it ever
// reaches Vikunja's frontend -- makes the resulting Map insertion order
// (and therefore the Gantt row order) cluster each project's tasks
// together, while leaving any existing parent/child DFS grouping (which
// doesn't depend on array order at all) untouched.
//
// Grouping alone isn't enough though: a task with only a due_date (no
// start_date) has start_date == the zero-value sentinel, which sorts as
// "year 1" -- so within a project's cluster it would always land first,
// regardless of when it's actually due, rather than in chronological
// order. sortKeyFor() falls back through start_date -> due_date ->
// end_date so ordering within each project group is still meaningful for
// tasks that only have a deadline set.
//
// Known limitation: Vikunja paginates this endpoint and this only reorders
// within a single page's response, so if one project's tasks are split
// across a page boundary they won't fully merge into one cluster.
const NO_DATE = '0001-01-01T00:00:00Z'

function sortKeyFor(task) {
	if (task.start_date && task.start_date !== NO_DATE) return task.start_date
	if (task.due_date && task.due_date !== NO_DATE) return task.due_date
	if (task.end_date && task.end_date !== NO_DATE) return task.end_date
	return '9999-12-31T00:00:00Z' // fully dateless tasks sort last within their project
}

function groupTasksByProject(bodyText) {
	let tasks
	try {
		tasks = JSON.parse(bodyText)
	} catch {
		return bodyText // not JSON (e.g. an error response) -- leave it alone
	}
	if (!Array.isArray(tasks)) return bodyText

	const projectOrder = []
	const byProject = new Map()
	for (const task of tasks) {
		const projectId = task.project_id
		if (!byProject.has(projectId)) {
			byProject.set(projectId, [])
			projectOrder.push(projectId)
		}
		byProject.get(projectId).push(task)
	}

	for (const group of byProject.values()) {
		group.sort((a, b) => {
			const keyA = sortKeyFor(a)
			const keyB = sortKeyFor(b)
			if (keyA !== keyB) return keyA < keyB ? -1 : 1
			return a.id - b.id
		})
	}

	return JSON.stringify(projectOrder.flatMap((projectId) => byProject.get(projectId)))
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

	// Ask Vikunja for uncompressed responses so injection/reordering can safely
	// do plain string/JSON manipulation instead of having to gunzip/brotli-decode first.
	const headers = {...req.headers}
	delete headers['accept-encoding']

	const reqUrl = new URL(req.url, 'http://internal')
	const wantsTaskGrouping = req.method === 'GET' && isGanttTaskListRequest(reqUrl)

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
			const isHtml = contentType.includes('text/html')
			const isJson = contentType.includes('application/json')

			if (!isHtml && !(wantsTaskGrouping && isJson)) {
				res.writeHead(proxyRes.statusCode, proxyRes.headers)
				proxyRes.pipe(res)
				return
			}

			const chunks = []
			proxyRes.on('data', (chunk) => chunks.push(chunk))
			proxyRes.on('end', () => {
				let body = Buffer.concat(chunks).toString('utf8')
				body = isHtml
					? (body.includes('</body>') ? body.replace('</body>', `${INJECT_TAG}</body>`) : body + INJECT_TAG)
					: groupTasksByProject(body)

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
