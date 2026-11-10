'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

/**
 * SQLite 를 열고 스키마를 적용한다.
 * @param {string} dbPath  파일 경로 또는 ':memory:'
 */
function open(dbPath) {
    if (dbPath !== ':memory:') {
        fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
    }

    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')

    const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql')
    db.exec(fs.readFileSync(schemaPath, 'utf8'))

    return db
}

/** 트랜잭션 헬퍼 */
function tx(db, fn) {
    db.exec('BEGIN')
    try {
        const result = fn()
        db.exec('COMMIT')
        return result
    } catch (err) {
        try { db.exec('ROLLBACK') } catch (_) { /* ignore */ }
        throw err
    }
}

module.exports = { open, tx }
