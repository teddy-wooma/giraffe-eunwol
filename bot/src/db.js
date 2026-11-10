'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

function open(dbPath) {
    if (dbPath !== ':memory:') {
        fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
    }
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`
        CREATE TABLE IF NOT EXISTS discord_threads (
            request_id TEXT PRIMARY KEY,
            thread_id  TEXT NOT NULL,
            nickname   TEXT,
            uuid       TEXT,
            status     TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL
        );
    `)
    return db
}

function get(db, requestId) {
    return db.prepare('SELECT * FROM discord_threads WHERE request_id = ?').get(requestId) || null
}

function save(db, request, threadId) {
    db.prepare(
        'INSERT OR REPLACE INTO discord_threads (request_id, thread_id, nickname, uuid, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(request.id, threadId, request.nickname || null, request.uuid || null, 'pending', new Date().toISOString())
}

function getByThread(db, threadId) {
    return db.prepare('SELECT * FROM discord_threads WHERE thread_id = ?').get(threadId) || null
}

function setStatus(db, requestId, status) {
    db.prepare('UPDATE discord_threads SET status = ? WHERE request_id = ?').run(status, requestId)
}

module.exports = { open, get, getByThread, save, setStatus }
