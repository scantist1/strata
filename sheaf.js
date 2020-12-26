// Sort function generator.
const ascension = require('ascension')
// Comparator decorator that extracts the sorted fields from an object.
const whittle = require('whittle')

// Node.js API.
const assert = require('assert')
const path = require('path')
const fileSystem = require('fs')
const fs = require('fs').promises

// Return the first non null-like value.
const coalesce = require('extant')

// Wraps a `Promise` in an object to act as a mutex.
const Future = require('prospective/future')

// An `async`/`await` work queue.
const Turnstile = require('turnstile')

// Journaled file system operations for tree rebalancing.
const Journalist = require('journalist')

// A pausable service work queue that shares a common application work queue.
const Fracture = require('fracture')

// A non-crypographic (fast) 32-bit hash for record integrity.
const fnv = require('./fnv')

// Serialize a single b-tree record.
const Recorder = require('transcript/recorder')

// Incrementally read a b-tree page chunk by chunk.
const Player = require('transcript/player')

// Binary search for a record in a b-tree page.
const find = require('./find')

const Partition = require('./partition')

// Currently unused.
function traceIf (condition) {
    if (condition) return function (...vargs) {
        console.log.apply(console, vargs)
    }
    return function () {}
}

// Sort function for file names that orders by their creation order.
const appendable = require('./appendable')

// An `Error` type specific to Strata.
const Strata = { Error: require('./error') }

// A latch.
function latch () {
    let capture
    return { unlocked: false, promise: new Promise(resolve => capture = { resolve }), ...capture }
}

// Sheaf is the crux of Strata. It exists as a separate object possibly for
// legacy reasons, and it will stay that way because it makes `Strata` and
// `Cursor` something a user can read to understand the interface.

//
class Sheaf {
    // Used to identify the pages of this instance in the page cache which can
    // be shared across different Strata. We do not want to pull pages from the
    // cache based only on the directory path and page id because we may close
    // and reopen a Strata and we'd pull pages from the previous instance.
    static _instance = 0
    static __instance = 0

    // Sheaf accepts the destructible and user options passed to `new Strata`
    constructor (destructible, options) {
        Strata.Error.assert(options.turnstile != null, 'OPTION_REQUIRED', { _option: 'turnstile' })
        Strata.Error.assert(options.directory != null, 'OPTION_REQUIRED', { _option: 'directory' })
        assert(destructible.isDestroyedIfDestroyed(options.turnstile.destructible))

        const leaf = coalesce(options.leaf, {})

        this._instance = Sheaf._instance++
        this.leaf = {
            split: coalesce(leaf.split, 5),
            merge: coalesce(leaf.merge, 1)
        }
        const branch = coalesce(options.branch, {})
        this.branch = {
            split: coalesce(branch.split, 5),
            merge: coalesce(branch.merge, 1)
        }
        this.cache = options.cache
        this.instance = 0
        this.directory = options.directory
        this.serializer = function () {
            const serializer = coalesce(options.serializer, 'json')
            switch (serializer) {
            case 'json':
                return {
                    parts: {
                        serialize: function (parts) {
                            return parts.map(part => Buffer.from(JSON.stringify(part)))
                        },
                        deserialize: function (parts) {
                            return parts.map(part => JSON.parse(part.toString()))
                        }
                    },
                    key: {
                        serialize: function (key) {
                            return [ Buffer.from(JSON.stringify(key)) ]
                        },
                        deserialize: function (parts) {
                            return JSON.parse(parts[0].toString())
                        }
                    }
                }
            case 'buffer':
                return {
                    parts: {
                        serialize: function (parts) { return parts },
                        deserialize: function (parts) { return parts }
                    },
                    key: {
                        serialize: function (part) { return [ part ] },
                        deserialize: function (parts) { return parts[0] }
                    }
                }
            default:
                return serializer
            }
        } ()
        this.extractor = coalesce(options.extractor, parts => parts[0])
        // **TODO** Dead code.
        if (options.comparator == null) {
        }
        this.comparator = function () {
            const zero = object => object
            if (options.comparator == null) {
                const comparator = whittle(ascension([ String ]), value => [ value ])
                return { leaf: comparator, branch: comparator, zero }
            } else if (typeof options.comparator == 'function') {
                return { leaf: options.comparator, branch: options.comparator, zero }
            } else {
                return options.comparator
            }
        } ()
        this.$_recorder = Recorder.create(() => '0')
        this._root = null

        // **TODO** Do not worry about wrapping anymore.
        // Operation id wraps at 32-bits, cursors should not be open that long.
        this._operationId = 0xffffffff


        // Concurrency and work queues. One keyed queue for page writes, the
        // other queue will only use a single key for all housekeeping.

        // **TODO** With `Fracture` we can probably start to do balancing in
        // parallel.
        this._fracture = {
            appender: new Fracture(destructible.durable($ => $(), 'appender'), options.turnstile, id => ({
                id: this._operationId = (this._operationId + 1 & 0xffffffff) >>> 0,
                writes: [],
                cartridge: this.cache.hold(id),
                latch: latch()
            }), this._append, this),
            housekeeper: new Fracture(destructible.durable($ => $(), 'housekeeper'), options.turnstile, () => ({
                candidates: []
            }), this._keephouse, this)
        }

        options.turnstile.deferrable.increment()

        this._id = 0
        this.closed = false
        this.destroyed = false
        this._destructible = destructible
        this._leftovers = []
        destructible.destruct(() => {
            this.destroyed = true
            destructible.ephemeral('shutdown', async () => {
                // Trying to figure out how to wait for the Turnstile to drain.
                // We can't terminate the housekeeping turnstile then the
                // acceptor turnstile because they depend on each other, so
                // we're going to loop. We wait for one to drain, then the
                // other, then check to see if anything is in the queues to
                // determine if we can leave the loop. Actually, we only need to
                // check the size of the first queue in the loop, the second
                // will be empty when `drain` returns.
                //
                // **TODO** Really want to just push keys into a file for
                // inspection when we reopen for housekeeping.
                await this.drain()
                options.turnstile.deferrable.decrement()
                if (this._root != null) {
                    this._root.remove()
                    this._root = null
                }
            })
        })
    }

    create (strata) {
        return this._destructible.exceptional('create', async () => {
            const directory = this.directory, stat = await fs.stat(directory)
            Strata.Error.assert(stat.isDirectory(), 'CREATE_NOT_DIRECTORY', { directory })
            Strata.Error.assert((await fs.readdir(directory)).filter(file => {
                return ! /^\./.test(file)
            }).length == 0, 'CREATE_NOT_EMPTY', { directory })

            this._root = this._create({ id: -1, leaf: false, items: [{ id: '0.0' }] })

            await fs.mkdir(this._path('instances', '0'), { recursive: true })
            await fs.mkdir(this._path('pages', '0.0'), { recursive: true })
            const buffer = this._recordify({ id: '0.1' }, [])
            const hash = fnv(buffer)
            await fs.writeFile(this._path('pages', '0.0', hash), buffer)
            await fs.mkdir(this._path('pages', '0.1'), { recursive: true })
            await fs.writeFile(this._path('pages', '0.1', '0.0'), Buffer.alloc(0))
            this._id++
            this._id++
            this._id++
            return strata
        })
    }

    open (strata) {
        return this._destructible.exceptional('open', async () => {
            // TODO Run commit log on reopen.
            this._root = this._create({ id: -1, items: [{ id: '0.0' }] })
            const instances = (await fs.readdir(this._path('instances')))
                .filter(file => /^\d+$/.test(file))
                .map(file => +file)
                .sort((left, right) => right - left)
            this.instance = instances[0] + 1
            await fs.mkdir(this._path('instances', this.instance))
            for (const instance of instances) {
                await fs.rmdir(this._path('instances', instance))
            }
            return strata
        })
    }

    async _hashable (id) {
        const regex = /^[a-z0-9]+$/
        const dir = await fs.readdir(this._path('pages', id))
        const files = dir.filter(file => regex.test(file))
        assert.equal(files.length, 1, `multiple branch page files: ${id}, ${files}`)
        return files.pop()
    }

    async _appendable (id) {
        const dir = await fs.readdir(this._path('pages', id))
        return dir.filter(file => /^\d+\.\d+$/.test(file)).sort(appendable).pop()
    }

    async _read (id, append) {
        const page = {
            id,
            leaf: true,
            items: [],
            vacuum: [],
            key: null,
            deletes: 0,
            // TODO Rename merged.
            deleted: false,
            lock: null,
            right: null,
            append
        }
        const player = new Player(function () { return '0' })
        const readable = fileSystem.createReadStream(this._path('pages', id, append))
        for await (const chunk of readable) {
            for (const entry of player.split(chunk)) {
                const header = JSON.parse(entry.parts.shift())
                switch (header.method) {
                case 'right': {
                        // TODO Need to use the key section of the record.
                        page.right = this.serializer.key.deserialize(entry.parts)
                        assert(page.right != null)
                    }
                    break
                case 'load': {
                        const { id, append } = header
                        const { page: loaded } = await this._read(id, append)
                        page.items = loaded.items
                        page.right = loaded.right
                        page.key = loaded.key
                        page.vacuum.push({ header: header, vacuum: loaded.vacuum })
                    }
                    break
                case 'slice': {
                        if (entry.header.length < page.items.length) {
                            page.right = page.items[entry.header.length].key
                        }
                        page.items = page.items.slice(entry.header.index, entry.header.length)
                    }
                    break
                case 'merge': {
                        const { page: right } = await this._read(header.id, header.append)
                        page.items.push.apply(page.items, right.items)
                        page.right = right.right
                        page.vacuum.push({ header: header, vacuum: right.vacuum })
                    }
                    break
                case 'insert': {
                        const parts = this.serializer.parts.deserialize(entry.parts)
                        page.items.splice(header.index, 0, {
                            key: this.extractor(parts),
                            parts: parts,
                            heft: entry.sizes.reduce((sum, size) => sum + size, 0)
                        })
                    }
                    break
                case 'delete': {
                        page.items.splice(header.index, 1)
                        // TODO We do not want to vacuum automatically, we want
                        // it to be optional, possibly delayed. Expecially for
                        // MVCC where we are creating short-lived trees, we
                        // don't care that they are slow to load due to splits
                        // and we don't have deletes.
                        page.deletes++
                    }
                    break
                case 'dependent': {
                        page.vacuum.push(entry)
                    }
                    break
                case 'key': {
                        page.key = this.serializer.key.deserialize(entry.parts)
                        break
                    }
                    break
                }
            }
        }
        assert(page.id == '0.1' ? page.key == null : page.key != null)
        const heft = page.items.reduce((sum, record) => sum + record.heft, 1)
        return { page, heft }
    }

    async read (id) {
        const leaf = +id.split('.')[1] % 2 == 1
        if (leaf) {
            return this._read(id, await this._appendable(id))
        }
        const hash = await this._hashable(id)
        const player = new Player(function () { return '0' })
        const buffer = await fs.readFile(this._path('pages', id, hash))
        const actual = fnv(buffer)
        Strata.Error.assert(actual == hash, 'BRANCH_BAD_HASH', {
            id, actual, expected: hash
        })
        const items = []
        for (const entry of player.split(buffer)) {
            const header = JSON.parse(entry.parts.shift())
            items.push({
                id: header.id,
                key: entry.parts.length != 0
                    ? this.serializer.key.deserialize(entry.parts)
                    : null
            })
        }
        return { page: { id, leaf, items, hash }, heft: buffer.length }
    }

    // We load the page then check for a race after we've loaded. If a different
    // strand beat us to it, we just ignore the result of our read and return
    // the cached entry.

    //
    async load (id) {
        if (this._verbose) {
            console.log('loading', id)
        }
        const { page, heft } = await this.read(id)
        const entry = this.cache.hold(id, null)
        if (entry.value == null) {
            entry.value = page
            entry.heft = heft
        }
        return entry
    }

    _create (page) {
        return this.cache.hold(page.id, page)
    }

    // TODO If `key` is `null` then just go left.
    _descend (entries, { key, level = -1, fork = false, rightward = false, approximate = false }) {
        const descent = { miss: null, keyed: null, level: 0, index: 0, entry: null }
        let entry = null
        entries.push(entry = this.cache.hold(-1))
        for (;;) {
            // When you go rightward at the outset or fork you might hit this
            // twice, but it won't matter because you're not going to use the
            // pivot anyway.
            //
            // You'll struggle to remember this, but it is true...
            if (descent.index != 0) {
                // The last key we visit is the key for the leaf page, if we're
                // headed to a leaf. We don't have to have the exact leaf key,
                // so if housekeeping is queued up in such a way that a leaf
                // page in the queue is absorbed by a merge prior to its
                // housekeeping inspection, the descent on that key is not going
                // to cause a ruckus. Keys are not going to disappear on us when
                // we're doing branch housekeeping.
                descent.pivot = {
                    key: entry.value.items[descent.index].key,
                    level: descent.level - 1
                }
                // If we're trying to find siblings we're using an exact key
                // that is definately above the level sought, we'll see it and
                // then go left or right if there is a branch in that direction.
                //
                // TODO Earlier I had this at KILLROY below. And I adjust the
                // level, but I don't reference the level, so it's probably fine
                // here.
                //
                // TODO What? Where is the comparator?!
                if (descent.pivot.key == key && fork) {
                    descent.index--
                    rightward = true
                }
            }

            // You don't fork right. You can track the rightward key though.
            if (descent.index + 1 < entry.value.items.length) {
                descent.right = entry.value.items[descent.index + 1].key
            }

            // We exit at the leaf, so this will always be a branch page.
            const id = entry.value.items[descent.index].id

            // Attempt to hold the page from the cache, return the id of the
            // page if we have a cache miss.
            entry = this.cache.hold(id)
            if (entry == null) {
                return { miss: id }
            }
            entries.push(entry)

            // TODO Move this down below the leaf return and do not search if
            // we are searching for a leaf.

            // Binary search the page for the key, or just go right or left
            // directly if there is no key.
            const offset = entry.value.leaf ? 0 : 1
            const index = rightward
                ? entry.value.leaf ? ~(entry.value.items.length - 1) : entry.value.items.length - 1
                : key != null
                    ? find(this.comparator.leaf, entry.value.items, key, offset)
                    : entry.value.leaf ? ~0 : 0

            // If the page is a leaf, assert that we're looking for a leaf and
            // return the leaf page.
            if (entry.value.leaf) {
                descent.found = index >= 0
                descent.index = index < 0 ? ~index : index
                assert.equal(level, -1, 'could not find branch')
                break
            }

            // If the index is less than zero we didn't find the exact key, so
            // we're looking at the bitwise not of the insertion point which is
            // right after the branch we're supposed to descend, so back it up
            // one.
            descent.index = index < 0 ? ~index - 1 : index

            // We're trying to reach branch and we've hit the level.
            if (level == descent.level) {
                break
            }

            // KILLROY was here.

            descent.level++
        }
        if (fork && !rightward) {
            if (approximate) {
                descent.index--
                descent.found = false
            } else {
                return null
            }
        }
        return descent
    }

    // We hold onto the entries array for the descent to prevent the unlikely
    // race condition where we cannot descend because we have to load a page,
    // but while we're loading a page another page in the descent unloads.
    //
    // Conceivably, this could continue indefinitely.

    //
    async descend (query, callerEntries, internal = true) {
        const entries = [[]]
        for (;;) {
            entries.push([])
            const descent = this._descend(entries[1], query)
            entries.shift().forEach(entry => entry.release())
            if (descent == null) {
                entries.shift().forEach((entry) => entry.release())
                return null
            }
            if (descent.miss == null) {
                callerEntries.push(descent.entry = entries[0].pop())
                entries.shift().forEach(entry => entry.release())
                return descent
            }
            const load = this.load(descent.miss)
            const entry = internal
                ? await load
                : await this._destructible.exceptional('load', load, true)
            entries[0].push(entry)
        }
    }

    descend2 (trampoline, query, found) {
        const entries = []
        try {
            const descent = this._descend(entries, query)
            if (descent.miss) {
                trampoline.promised(async () => {
                    try {
                        entries.push(await this.load(descent.miss))
                        this.descend2(trampoline, query, found)
                    } finally {
                        entries.forEach(entry => entry.release())
                    }
                })
            } else {
                if (descent != null) {
                    descent.entry = entries.pop()
                }
                entries.forEach(entry => entry.release())
                found(descent)
            }
        } catch (error) {
            entries.forEach(entry => entry.release())
            throw error
        }
    }

    async _writeLeaf (id, writes) {
        const append = await this._appendable(id)
        await fs.appendFile(this._path('pages', id, append), Buffer.concat(writes))
    }

    // Writes appear to be able to run with impunity. What was the logic there?
    // Something about the leaf being written to synchronously, but if it was
    // asynchronous, then it is on the user to assert that the page has not
    // changed.
    //
    // The block will wait on a promise release preventing any of the writes
    // from writing.
    //
    // Keep in mind that there is only one housekeeper, so that might factor
    // into the logic here.
    //
    // Can't see what's preventing writes from becoming stale. Do I ensure that
    // they are written before the split? Must be.

    //
    async _append ({ canceled, key, value: { writes, cartridge, latch } }) {
        try {
            this._destructible.progress()
            const page = cartridge.value
            if (this._verbose && key == '0.1') {
                console.log('appnd', page.id, page.items.length, page._seen, writes.length)
            }
            if (
                (
                    page.items.length >= this.leaf.split &&
                    this.comparator.branch(page.items[0].key, page.items[page.items.length - 1].key) != 0
                )
                ||
                (
                    ! (page.id == '0.1' && page.right == null) &&
                    page.items.length <= this.leaf.merge
                )
            ) {
                this._fracture.housekeeper.enqueue('housekeeping').candidates.push(page.key || page.items[0].key)
            }
            await this._writeLeaf(page.id, writes)
        } finally {
            cartridge.release()
            latch.unlocked = true
            latch.resolve.call(null)
        }
    }

    append (id, buffer, writes) {
        if (this._verbose) {
            throw new Error
        }
        // **TODO** Optional boolean other than `destroyed`.
        this._destructible.operational()
        const append = this._fracture.appender.enqueue(id)
        append.writes.push(buffer)
        if (writes[append.id] == null) {
            writes[append.id] = append.latch
        }
    }

    async drain () {
        do {
            await this._fracture.housekeeper.drain()
            await this._fracture.appender.drain()
        } while (this._fracture.housekeeper.count != 0)
    }

    _path (...vargs) {
        vargs.unshift(this.directory)
        return path.resolve.apply(path, vargs.map(varg => String(varg)))
    }

    _nextId (leaf) {
        let id
        do {
            id = this._id++
        } while (leaf ? id % 2 == 0 : id % 2 == 1)
        return String(this.instance) + '.' +  String(id)
    }

    // TODO Why are you using the `_id` for both file names and page ids?
    _filename (id) {
        return `${this.instance}.${this._id++}`
    }

    _serialize (header, parts) {
        return this._recordify(header, parts.length == 0 ? parts : this.serializer.parts.serialize(parts))
    }

    _recordify (header, parts) {
        return this.$_recorder([[ Buffer.from(JSON.stringify(header)) ].concat(parts)])
    }

    _stub (commit, id, append, records) {
        const buffer = Buffer.concat(records.map(record => {
            if (Buffer.isBuffer(record)) {
                return record
            }
            return record.buffer ? record.buffer : this._serialize(record.header, record.parts)
        }))
        const filename = path.join('pages', id, append)
        return commit.writeFile(filename, buffer)
    }

    async _writeBranch (commit, entry) {
        const buffers = []
        for (const { id, key } of entry.value.items) {
            const parts = key != null
                ? this.serializer.key.serialize(key)
                : []
            buffers.push(this._recordify({ id }, parts))
        }
        const buffer = Buffer.concat(buffers)
        entry.heft = buffer.length
        if (entry.value.hash != null) {
            const previous = path.join('pages', entry.value.id, entry.value.hash)
            await commit.unlink(previous)
        }
        const write = await commit.writeFile(hash => path.join('pages', entry.value.id, hash), buffer)
        entry.value.hash = write.hash
    }

    // TODO Concerned about vacuum making things slow relative to other
    // databases and how to tune it for performance. Splits don't leave data on
    // disk that doesn't need to be there, but they do mean that a split page
    // read will read in records that it will then discard with a split. Merge
    // implies a lot of deletion. Then their may be a page that never splits or
    // merges, it stays within that window but constantly inserts and deletes a
    // handful of records leaving a lot of deleted records.
    //
    // However, as I'm using it now, there are trees vacuum doesn't buy me much.
    // Temporary trees in the MVCC implementations, they are really just logs.

    // **TODO** No longer liking split being what it is. Why not just vacuum at
    // split and merge of leaf pages? Then we don't have to do this dependency
    // management? Reads for splits would degenerate without merge. When you
    // have a long enough history you end up reading in many page, splitting
    // many pages. If a vacuum takes place in the background, why not vacuum at
    // each split? How big can a page be? It fits in memory.

    // **TODO** Shared WAL is a matter of using keys to separate among different
    // b-trees. Gives me the idea of a WAL-only tree which can be used for the
    // stages in Amalgamate. We rotate stages when we rotate the WAL. Then when
    // merge the WAL anything that is part of a rotate stage can be simply
    // skipped. We retain the primary and stage trees and the merging. Cleanup
    // is now more or less automatic.

    // **TODO** You can have a WAL only b-tree and a b-tree that is a no-WAL
    // b-tree, it only uses WAL for split and merge and there you have pretty
    // much created a WAL database.

    // **TODO** Vacuum is nice, but we have to run it eventually anyway. Yes we
    // could defer vaccum, and when you read through this, you'll see that it
    // actually does work. It has reference counting for the append files and
    // and append file is not deleted until all the dependencies are gone.

    // We can bookmark this version of the code and come back to it, but I don't
    // see why we wouldn't go ahead and do a vacuum on split and merge. It would
    // keep us from having linked lists of pages that we have to reference
    // count. We can implement this vacuum logic directly in `_splitLeaf` and
    // `_mergeLeaf`. We can make the stub construct and commit it. Then vacuum
    // the leaf page and perform the branch split/merge all in a single
    // Journalist commit. Also, Journalist should have the option of emitting a
    // message so that if on recover we could set we'd established our stubs and
    // need to vacuum them.

    //
    async _vacuum (key) {
        const entries = []
        const leaf = await this.descend({ key }, entries)

        const first = this._filename()
        const second = this._filename()

        const { items, dependencies } = await (async () => {
            const pause = await this._fracture.appender.pause(leaf.entry.value.id)
            try {
                const items = leaf.entry.value.items.slice(0)

                const dependencies = function map ({ id, append }, dependencies, mapped = {}) {
                    assert(mapped[`${id}/${append}`] == null)
                    const page = mapped[`${id}/${append}`] = {}
                    for (const dependency of dependencies) {
                        switch (dependency.header.method) {
                        case 'load':
                        case 'merge': {
                                map(dependency.header, dependency.vacuum, mapped)
                            }
                            break
                        case 'dependent': {
                                const { id, append } = dependency.header
                                assert(!page[`${id}/${append}`])
                                page[`${id}/${append}`] = true
                            }
                            break
                        }
                    }
                    return mapped
                } (leaf.entry.value, leaf.entry.value.vacuum)

                // Flush any existing writes. We're still write blocked.
                const writes = []
                for (const entry of pause.entries) {
                    writes.push.apply(writes, entry.writes.splice(0))
                }
                await this._writeLeaf(leaf.entry.value.id, writes)

                // Create our journaled tree alterations.
                const commit = await Journalist.create(this.directory)

                // Create a stub that loads the existing page.
                const previous = leaf.entry.value.append
                await this._stub(commit, leaf.entry.value.id, first, [{
                    header: {
                        method: 'load',
                        id: leaf.entry.value.id,
                        append: previous
                    },
                    parts: []
                }, {
                    header: {
                        method: 'dependent',
                        id: leaf.entry.value.id,
                        append: second
                    },
                    parts: []
                }])
                await this._stub(commit, leaf.entry.value.id, second, [{
                    header: {
                        method: 'load',
                        id: leaf.entry.value.id,
                        append: first
                    },
                    parts: []
                }])
                leaf.entry.value.append = second
                leaf.entry.value.entries = [{
                    header: { method: 'load', id: leaf.entry.value.id, append: first },
                    entries: [{
                        header: { hmethod: 'dependent', id: leaf.entry.value.id, append: second }
                    }]
                }]

                await commit.write()
                await Journalist.prepare(commit)
                await Journalist.commit(commit)
                await commit.dispose()

                return { items, dependencies }
            } finally {
                pause.resume()
            }
        }) ()

        await (async () => {
            const commit = await Journalist.create(this.directory)

            await commit.unlink(path.join('pages', leaf.entry.value.id, first))

            const buffers = []
            const { id, right, key } = leaf.entry.value

            if (right != null) {
                buffers.push(this._recordify({ method: 'right' }, this.serializer.key.serialize(right)))
            }
            // Write out a new page slowly, a record at a time.
            for (let index = 0, I = items.length; index < I; index++) {
                const parts = this.serializer.parts.serialize(items[index].parts)
                buffers.push(this._recordify({ method: 'insert', index }, parts))
            }
            if (key != null) {
                buffers.push(this._recordify({ method: 'key' }, this.serializer.key.serialize(key)))
            }
            buffers.push(this._recordify({
                method: 'dependent', id: id, append: second
            }, []))

            await commit.writeFile(path.join('pages', id, first), Buffer.concat(buffers))
            // Merged pages themselves can just be deleted, but when we do, we
            // need to... Seems like both split and merge can use the same
            // mechanism, this dependent reference. So, every page we load has a
            // list of dependents. We can eliminate any that we know we can
            // delete.

            // Delete previous versions. Oof. Split means we have multiple
            // references.
            const deleted = {}
            const deletions = {}

            // Could save some file operations by maybe doing the will be deleted
            // removals first, but this logic is cleaner.
            for (const page in dependencies) {
                for (const dependent in dependencies[page]) {
                    const [ id, append ] = dependent.split('/')
                    try {
                        await fs.stat(this._path('pages', id, append))
                    } catch (error) {
                        Strata.Error.assert(error.code == 'ENOENT', 'VACUUM_FILE_IO', error, { id, append })
                        deleted[dependent] = true
                    }
                }
            }

            let loop = true
            while (loop) {
                loop = false
                for (const page in dependencies) {
                    if (Object.keys(dependencies[page]).length == 0) {
                        loop = true
                        deleted[page] = true
                        deletions[page] = true
                        delete dependencies[page]
                    } else {
                        for (const dependent in dependencies[page]) {
                            if (deleted[dependent]) {
                                loop = true
                                delete dependencies[page][dependent]
                            }
                        }
                    }
                }
            }

            // Delete all merged pages.
            for (const deletion in deletions) {
                const [ id, append ] = deletion.split('/')
                await commit.unlink(path.join('pages', id, append))
            }

            await commit.write()
            await Journalist.prepare(commit)
            await Journalist.commit(commit)
            await commit.dispose()
        }) ()

        if (this._verbose && leaf.entry.value.id == '0.1') {
            console.log('vcuum', leaf.entry.value.id, leaf.entry.value.items.length)
        }

        entries.forEach(entry => entry.release())
    }

    // Assume there is nothing to block or worry about with the branch pages.
    // Can't recall at the moment, though. Descents are all synchronous.
    //
    // You've come back to this and it really bothers you that these slices are
    // performed twice, once in the journalist and once in the commit. You
    // probably want to let this go for now until you can see clearly how you
    // might go about eliminating this duplication. Perhaps the commit uses the
    // journalist to descend, lock, etc. just as the Cursor does. Or maybe the
    // Journalist is just a Sheaf of pages, which does perform the leaf write,
    // but defers to the Commit, now called a Journalist, to do the splits.
    //
    // It is not the case that the cached information is in some format that is
    // not ready for serialization. What do we get exactly? What we'll see at
    // first is that these two are calling each other a lot, so we're going to
    // probably want to move more logic back over to Commit, including leaf
    // splits. It will make us doubt that we could ever turn this easily into an
    // R*Tree but the better the architecture, the easier it will be to extract
    // components for reuse as modules, as opposed to making this into some sort
    // of pluggable framework.
    //
    // Maybe it just came to me. Why am I logging `drain`, `fill`, etc? The
    // commit should just expose `emplace` and the journalist can do the split
    // and generate the pages and then the Commit is just journaled file system
    // operations. It won't even update the heft, it will just return the new
    // heft and maybe it doesn't do the page reads either.
    //
    // We'd only be duplicating the splices, really.

    //
    async _drainRoot (key) {
        const entries = []
        const root = await this.descend({ key, level: 0 }, entries)
        const partition = Math.floor(root.entry.value.items.length / 2)
        // TODO Print `root.page.items` and see that heft is wrong in the items.
        // Why is it in the items and why is it wrong? Does it matter?
        const left = this._create({
            id: this._nextId(false),
            offset: 1,
            items: root.entry.value.items.slice(0, partition),
            hash: null
        })
        entries.push(left)
        const right = this._create({
            id: this._nextId(false),
            offset: 1,
            items: root.entry.value.items.slice(partition),
            hash: null
        })
        entries.push(right)
        root.entry.value.items = [{
            id: left.value.id,
            key: null
        }, {
            id: right.value.id,
            key: right.value.items[0].key
        }]
        right.value.items[0].key = null
        const commit = await Journalist.create(this.directory)
        // Write the new branch to a temporary file.
        await this._writeBranch(commit, right)
        await this._writeBranch(commit, left)
        await this._writeBranch(commit, root.entry)
        // Record the commit.
        await commit.write()
        await Journalist.prepare(commit)
        await Journalist.commit(commit)
        await commit.dispose()
        entries.forEach(entry => entry.release())
    }

    async _possibleSplit (page, key, level) {
        if (page.items.length >= this.branch.split) {
            if (page.id == '0.0') {
                await this._drainRoot(key)
            } else {
                await this._splitBranch(key, level)
            }
        }
    }

    async _splitBranch (key, level) {
        const entries = []
        const branch = await this.descend({ key, level }, entries)
        const parent = await this.descend({ key, level: level - 1 }, entries)
        const partition = Math.floor(branch.entry.value.items.length / 2)
        const right = this._create({
            id: this._nextId(false),
            leaf: false,
            items: branch.entry.value.items.splice(partition),
            heft: 1,
            hash: null
        })
        entries.push(right)
        const promotion = right.value.items[0].key
        right.value.items[0].key = null
        branch.entry.value.items = branch.entry.value.items.splice(0, partition)
        parent.entry.value.items.splice(parent.index + 1, 0, { key: promotion, id: right.value.id })
        const commit = await Journalist.create(this.directory)
        // Write the new branch to a temporary file.
        await this._writeBranch(commit, right)
        await this._writeBranch(commit, branch.entry)
        await this._writeBranch(commit, parent.entry)
        // Record the commit.
        await commit.write()
        await Journalist.prepare(commit)
        await Journalist.commit(commit)
        await commit.dispose()
        entries.forEach(entry => entry.release())
        await this._possibleSplit(parent.entry.value, key, parent.level)
        // TODO Is this necessary now that we're splitting a page at a time?
        // await this._possibleSplit(branch.entry.value, key, level)
        // await this._possibleSplit(right.value, partition, level)
    }

    // Split leaf. We always split a new page off to the right. Because we
    // always merge two pages together into the left page our left-most page id
    // will never change, it will always be `0.1`.
    //
    // Split is performed by creating two new stub append log. One for the
    // existing page which is now the left page and one for the new right page.
    // When either of these pages loads they will load the old existing page,
    // then split the page and continue with new records added to the subsequent
    // append log.
    _seen = 0
    //
    async _splitLeaf (key, child, entries) {
        // Descend to the parent branch page.
        const parent = await this.descend({ key, level: child.level - 1 }, entries)

        // Create the right page now so we can lock it. We're going to
        // synchronously add it to the tree and then do the housekeeping to
        // persist the split asynchronously. While we're async, someone could
        // descend the tree and start writing. In fact, this is very likely to
        // happen during a batch insert by the user.
        const right = this._create({
            id: this._nextId(true),
            leaf: true,
            items: [],
            vacuum: [],
            right: child.entry.value.right,
            append: this._filename()
        })
        entries.push(right)

        if (this._verbose && child.entry.value.id == '0.1') {
            console.log('split', child.entry.value.id, child.entry.value.items.length, child.entry.value._seen, child.entry.value._splitting)
            if (child.entry.value._seen == null) {
                child.entry.value._seen = this._seen++
            }
            child.entry.value.items.forEach(item => item._seen == null && (item._seen = this._seen++))
            console.log('items', child.entry.value.items.map(item => [ item.key[0].toString(), item.key[1], item.key[2], item._seen ]))
            child.entry.value._splitting = true
        }

        // Create our journaled tree alterations.
        const commit = await Journalist.create(this.directory)
        const pauses = []
        try {
            pauses.push(await this._fracture.appender.pause(child.entry.value.id))
            pauses.push(await this._fracture.appender.pause(right.value.id))
            // Race is the wrong word, it's our synchronous time. We have to split
            // the page and then write them out. Anyone writing to this leaf has to
            // to be able to see the split so that they surrender their cursor if
            // their insert or delete belongs in the new page, not the old one.
            //
            // Notice that all the page manipulation takes place before the first
            // write. Recall that the page manipulation is done to the page in
            // memory which is offical, the page writes are lagging.

            // Split page creating a right page.
            const length = child.entry.value.items.length
            const partition = Partition(this.comparator.branch, child.entry.value.items)
            // If we cannot partition because the leaf and branch have different
            // partition comparators and the branch comparator considers all keys
            // identical, we give up and return. We will have gone through the
            // housekeeping queue to get here, and if the user keeps inserting keys
            // that are identical according to the branch comparator, we'll keep
            // making our futile attempts to split. Currently, though, we're only
            // going to see this behavior in Amalgamate when someone is staging an
            // update to the same key, say inserting it and deleting it over and
            // over, and then if they are doing it as part of transaction, we'd only
            // attempt once for each batch of writes. We could test the partition
            // before the entry into the housekeeping queue but then we have a
            // racing unit test to write to get this branch to execute, so I won't
            // bother until someone actually complains. It would mean a stage with
            // 100s of updates to one key that occur before the stage can merge
            // before start to his this early exit.
            if (partition == null) {
                entries.forEach(entry => entry.release())
                right.remove()
                return
            }
            const items = child.entry.value.items.splice(partition)
            right.value.key = this.comparator.zero(items[0].key)
            right.value.items = items
            right.heft = items.reduce((sum, item) => sum + item.heft, 1)
            // Set the right key of the left page.
            child.entry.value.right = right.value.key
            child.entry.heft -= right.heft - 1

            if (this._verbose && child.entry.value.id == '0.1') {
                console.log('splat', child.entry.value.id, child.entry.value.items.length)
            }
            // Set the heft of the left page and entry. Moved this down.
            // child.entry.heft -= heft - 1

            // Insert a reference to the right page in the parent branch page.
            parent.entry.value.items.splice(parent.index + 1, 0, {
                key: right.value.key,
                id: right.value.id,
                // TODO For branches, let's always just re-run the sum.
                heft: 0
            })

            // If any of the pages is still larger than the split threshhold, check
            // the split again.
            for (const page of [ right.value, child.entry.value ]) {
                if (
                    page.items.length >= this.leaf.split &&
                    this.comparator.branch(page.items[0].key, page.items[page.items.length - 1].key) != 0
                ) {
                    this._fracture.housekeeper.enqueue('housekeeping').candidates.push(page.key || page.items[0].key)
                }
            }

            // Write any queued writes, they would have been in memory, in the page
            // that was split above. We based our split on these writes.
            //
            // Once we await our synchronous operations are over. The user can
            // append new writes to the existing queue entry. The user will have
            // checked that their page is still valid and will descend the tree if
            // `Cursor.indexOf` can't find a valid index for their page, so we don't
            // have to worry about the user inserting a record in the split page
            // when it should be inserted into the right page.
            const append = this._filename()
            const dependents = [{
                header: {
                    method: 'dependent', id: child.entry.value.id, append, was: 'split'
                },
                parts: []
            }, {
                header: {
                    method: 'dependent', id: right.value.id, append: right.value.append, was: 'split'
                },
                parts: []
            }]
            const writes = []
            for (const entries of pauses[0].entries) {
                writes.push.apply(writes, entries.writes.splice(0))
            }
            writes.push.apply(writes, dependents.map(write => this._serialize(write.header, [])))
            await this._writeLeaf(child.entry.value.id, writes)

            // TODO We adjust heft now that we've written out all the relevant
            // leaves, but we kind of have a race now, more items could have been
            // added or removed in the interim. Seems like we should just
            // recalcuate, but we can also assert.

            // Maybe the only real issue is that the writes above are going to
            // update the left of the split page regardless of whether or not the
            // record is to the left or the right. This might be fine.

            //
            /*
            right.heft = items.reduce((sum, item) => sum + item.heft, 1)
            child.entry.heft -= right.heft - 1
            */

            child.entry.value.vacuum.push.apply(child.entry.value.vacuum, dependents)

            // Curious race condition here, though, where we've flushed the page to
            // split

            // TODO Make header a nested object.


            // Record the split of the right page in a new stub.
            await this._stub(commit, right.value.id, right.value.append, [{
                header: {
                    method: 'load',
                    id: child.entry.value.id,
                    append: child.entry.value.append
                },
                parts: []
            }, {
                header: {
                    method: 'slice',
                    index: partition,
                    length: length,
                },
                parts: []
            }, {
                header: { method: 'key' },
                parts: this.serializer.key.serialize(right.value.key)
            }])
            right.value.vacuum = [{
                header: { method: 'load', id: child.entry.value.id, append: child.entry.value.append,
                    was: 'right' },
                vacuum: child.entry.value.vacuum
            }]

            // Record the split of the left page in a new stub, for which we create
            // a new append file.
            await this._stub(commit, child.entry.value.id, append, [{
                header: {
                    method: 'load',
                    id: child.entry.value.id,
                    append: child.entry.value.append
                },
                parts: []
            }, {
                header: {
                    method: 'slice',
                    index: 0,
                    length: partition
                },
                parts: []
            }])
            child.entry.value.vacuum = [{
                header: { method: 'load', id: child.entry.value.id, append: child.entry.value.append,
                    was: 'child' },
                vacuum: child.entry.value.vacuum
            }]
            child.entry.value.append = append

            // Commit the stubs before we commit the updated branch.
            commit.partition()

            // Write the new branch to a temporary file.
            await this._writeBranch(commit, parent.entry)

            // Record the commit.
            await commit.write()
            await Journalist.prepare(commit)
            await Journalist.commit(commit)
        } finally {
            pauses.forEach(pause => pause.resume())
        }
        await Journalist.prepare(commit)
        await Journalist.commit(commit)
        await commit.dispose()
        // We can release and then perform the split because we're the only one
        // that will be changing the tree structure.
        entries.forEach(entry => entry.release())
        await this._possibleSplit(parent.entry.value, key, parent.level)

        // TODO This is expensive, if we do it ever time, and silly if we're not
        // filling a page with deletions, a vacuum will reduce the number of
        // files, but not significantly reduce the size on disk, nor would it
        // really reduce the amount of time it takes to load. For now I'm
        // vacuuming dilligently in order to test vacuum and find bugs.
        await this._vacuum(key)
        await this._vacuum(right.value.key)

        if (this._verbose && child.entry.value.id == '0.1') {
            console.log('splid')
            child.entry.value._splitting = false
        }
    }


    // **TODO** Something is wrong here. We're using `child.right` to find the a
    // right branch page but the leaf and and it's right sibling can always be
    // under the same branch. How do we really go right?
    //
    // **TODO** The above is a major problem. This is super broken. We may end
    // up merging a page into nothing.
    //
    // **TODO** Regarding the above. Stop and think about it and you can see
    // that you can always pick up the right key of the page at a particular
    // level as you descend the tree. On the way down, update a right variable
    // with the id of the page for the node to the right of the node you
    // followed if one exists. If the page you followed is at the end of the
    // array do not update it. Wait... Is that what `child.right` is here? Heh.
    // It might well be. I see am tracking right as I descend.
    //
    // **TODO** LOL at all that above and if you're smarter when you wrote the
    // code than when you wrote these comments, rewrite all this into a
    // description so you don't do this again.

    //
    async _selectMerger (key, child, entries) {
        const level = child.entry.value.leaf ? -1 : child.level
        const left = await this.descend({ key, level, fork: true }, entries)
        const right = child.right == null
                    ? null
                    : await this.descend({ key: child.right, level }, entries)
        const mergers = []
        if (left != null) {
            mergers.push({
                items: left.entry.value.items,
                key: child.entry.value.key || child.entry.value.items[0].key,
                level: level
            })
        }
        if (right != null) {
            mergers.push({
                items: right.entry.value.items,
                count: right.entry.value.items.length,
                key: child.right,
                level: level
            })
        }
        return mergers
            .filter(merger => this.comparator.branch(merger.items[0].key, merger.items[merger.items.length - 1].key) != 0)
            .sort((left, right) => left.items.length - right.items.length)
            .shift()
    }

    _isDirty (page, sizes) {
        return (
            page.items.length >= sizes.split &&
            this.comparator.branch(page.items[0].key, page.items[page.items.length - 1].key) != 0
        )
        ||
        (
            ! (page.id == '0.1' && page.right == null) &&
            page.items.length <= sizes.merge
        )
    }

    async _surgery (right, pivot) {
        const surgery = {
            deletions: [],
            replacement: null,
            splice: pivot
        }

        // If the pivot is somewhere above we need to promote a key, unless all
        // the branches happen to be single entry branches.
        if (right.level - 1 != pivot.level) {
            let level = right.level - 1
            do {
                const ancestor = this.descend({ key, level }, entries)
                if (ancestor.entry.value.items.length == 1) {
                    surgery.deletions.push(ancestor)
                } else {
                    // TODO Also null out after splice.
                    assert.equal(ancestor.index, 0, 'unexpected ancestor')
                    surgery.replacement = ancestor.entry.value.items[1].key
                    surgery.splice = ancestor
                }
                level--
            } while (surgery.replacement == null && level != right.pivot.level)
        }

        return surgery
    }

    async _fill (key) {
        const entries = []

        const root = await this.descend({ key, level: 0 }, entries)
        const child = await this.descend({ key, level: 1 }, entries)

        root.entry.value.items = child.entry.value.items

        // Create our journaled tree alterations.
        const commit = await Journalist.create(this.directory)

        // Write the merged page.
        await this._writeBranch(commit, root.entry)

        // Delete the page merged into the merged page.
        await commit.rmdir(path.join('pages', child.entry.value.id))

        // Record the commit.
        await commit.write()
        await Journalist.prepare(commit)
        await Journalist.commit(commit)
        await commit.dispose()

        entries.forEach(entry => entry.release())
    }

    async _possibleMerge (surgery, key, branch) {
        if (surgery.splice.entry.value.items.length <= this.branch.merge) {
            if (surgery.splice.entry.value.id != '0.0') {
                // TODO Have `_selectMerger` manage its own entries.
                const entries = []
                const merger = await this._selectMerger(key, surgery.splice, entries)
                entries.forEach(entry => entry.release())
                await this._mergeBranch(merger)
            } else if (branch && this.branch.merge == 1) {
                await this._fill(key)
            }
        }
    }

    async _mergeBranch ({ key, level }) {
        const entries = []

        const left = await this.descend({ key, level, fork: true }, entries)
        const right = await this.descend({ key, level }, entries)

        const pivot = await this.descend(right.pivot, entries)

        const surgery = await this._surgery(right, pivot)

        right.entry.value.items[0].key = key
        left.entry.value.items.push.apply(left.entry.value.items, right.entry.value.items)

        // Replace the key of the pivot if necessary.
        if (surgery.replacement != null) {
            pivot.entry.value.items[pivot.index].key = surgery.replacement
        }

        // Remove the branch page that references the leaf page.
        surgery.splice.entry.value.items.splice(surgery.splice.index, 1)

        // If the splice index was zero, null the key of the new left most branch.
        if (surgery.splice.index == 0) {
            surgery.splice.entry.value.items[0].key = null
        }

        // Create our journaled tree alterations.
        const commit = await Journalist.create(this.directory)

        // Write the merged page.
        await this._writeBranch(commit, left.entry)

        // Delete the page merged into the merged page.
        await commit.rmdir(path.join('pages', right.entry.value.id))

        // If we replaced the key in the pivot, write the pivot.
        if (surgery.replacement != null) {
            await this._writeBranch(commit, pivot.entry)
        }

        // Write the page we spliced.
        await this._writeBranch(commit, surgery.splice.entry)

        // Delete any removed branches.
        for (const deletion in surgery.deletions) {
            await commit.unlink(path.join('pages', deletion.entry.value.id))
        }

        // Record the commit.
        await commit.write()
        await Journalist.prepare(commit)
        await Journalist.commit(commit)
        await commit.dispose()

        let leaf = left.entry
        // We don't have to restart our descent on a cache miss because we're
        // the only ones altering the shape of the tree.
        //
        // TODO I'm sure there is a way we can find this on a descent somewhere,
        // that way we don't have to test this hard-to-test cache miss.
        while (!leaf.value.leaf) {
            const id = leaf.value.items[0].id
            leaf = this.cache.hold(id)
            if (leaf == null) {
                entries.push(leaf = await this.load(id))
            } else {
                entries.push(leaf)
            }
        }

        entries.forEach(entry => entry.release())

        await this._possibleMerge(surgery, leaf.value.items[0].key, true)
    }

    async _mergeLeaf ({ key, level }) {
        const entries = []

        const left = await this.descend({ key, level, fork: true }, entries)
        const right = await this.descend({ key, level }, entries)

        if (this._verbose && left.entry.value.id == '0.1') {
            console.log('merge', left.entry.value.id, left.entry.value.items.length)
            console.log('merge', right.entry.value.id, right.entry.value.items.length)
        }

        const pivot = await this.descend(right.pivot, entries)

        const surgery = await this._surgery(right, pivot)

        // Create our journaled tree alterations.
        const commit = await Journalist.create(this.directory)

        const pauses = []
        try {
            pauses.push(await this._fracture.appender.pause(left.entry.value.id))
            pauses.push(await this._fracture.appender.pause(right.entry.value.id))

            // Add the items in the right page to the end of the left page.
            const items = left.entry.value.items
            const merged = right.entry.value.items.splice(0)
            items.push.apply(items, merged)

            // Set right reference of left page.
            left.entry.value.right = right.entry.value.right

            // Adjust heft of left entry.
            left.entry.heft += right.entry.heft - 1

            // TODO Remove after a while, used only for assertion in `Cache`.
            right.entry.heft -= merged.reduce((sum, value) => {
                return sum + value.heft
            }, 0)

            // Mark the right page deleted, it will cause `indexOf` in the `Cursor`
            // to return `null` indicating that the user must release the `Cursor`
            // and descend again.
            right.entry.value.deleted = true

            // See if the merged page needs to split or merge further.
            if (this._isDirty(left.entry.value, this.leaf)) {
                this._fracture.housekeeper.enqueue('housekeeping').candidates.push(left.entry.value.items[0].key)
            }

            // Replace the key of the pivot if necessary.
            if (surgery.replacement != null) {
                pivot.entry.value.items[pivot.index].key = surgery.replacement
            }

            // Remove the branch page that references the leaf page.
            surgery.splice.entry.value.items.splice(surgery.splice.index, 1)

            if (surgery.splice.index == 0) {
                surgery.splice.entry.value.items[0].key = null
            }

            // Now we've rewritten the branch tree and merged the leaves. When we go
            // asynchronous `Cursor`s will be invalid and they'll have to descend
            // again. User writes will continue in memory, but leaf page writes are
            // currently blocked. We start by flushing any cached writes.
            //
            // TODO Apparently we don't add a dependent record to the left since it
            // has the same id, we'd depend on ourselves, but vacuum ought to erase
            // it.
            const writes = { left: [], right: [] }

            for (const entry of pauses[0].entries) {
                writes.left.push.apply(writes.left, entry.writes.splice(0))
            }

            for (const entry of pauses[1].entries) {
                writes.right.push.apply(writes.right, entry.writes.splice(0))
            }

            writes.right.push(this._serialize({
                method: 'dependent',
                id: left.entry.value.id,
                append: left.entry.value.append
            }, []))

            await this._writeLeaf(left.entry.value.id, writes.left)
            await this._writeLeaf(right.entry.value.id, writes.right)

            // Record the split of the right page in a new stub.
            const append = this._filename()
            await this._stub(commit, left.entry.value.id, append, [{
                header: {
                    method: 'load',
                    id: left.entry.value.id,
                    append: left.entry.value.append
                },
                parts: []
            }, {
                header: {
                    method: 'merge',
                    id: right.entry.value.id,
                    append: right.entry.value.append
                },
                parts: []
            }])
            // TODO Okay, forgot what `entries` is and it appears to be just the
            // entries needed to determine dependencies so we can unlink files when
            // we vaccum.
            left.entry.value.entries = [{
                method: 'load', id: left.entry.value.id, append: left.entry.value.append,
                entries: left.entry.value.entries
            }, {
                method: 'merge', id: right.entry.value.id, append: right.entry.value.append,
                entries: right.entry.value.entries
            }]
            left.entry.value.append = append

            // Commit the stub before we commit the updated branch.
            commit.partition()

            // If we replaced the key in the pivot, write the pivot.
            if (surgery.replacement != null) {
                await this._writeBranch(commit, pivot.entry)
            }

            // Write the page we spliced.
            await this._writeBranch(commit, surgery.splice.entry)

            // Delete any removed branches.
            for (const deletion in surgery.deletions) {
                await commit.unlink(path.join('pages', deletion.entry.value.id))
            }

            // Record the commit.
            await commit.write()
            await Journalist.prepare(commit)
            await Journalist.commit(commit)
        } finally {
            pauses.forEach(pause => pause.resume())
        }
        await Journalist.prepare(commit)
        await Journalist.commit(commit)
        await commit.dispose()

        // We can release and then perform the split because we're the only one
        // that will be changing the tree structure.
        entries.forEach(entry => entry.release())

        await this._possibleMerge(surgery, left.entry.value.items[0].key, false)
    }

    _verbose = false

    // TODO Must wait for housekeeping to finish before closing.
    async _keephouse ({ canceled, value: { candidates } }) {
        if (!this._verbose) {
            this._verbose = candidates.length == 7
        }
        if (this._verbose) {
            console.log('keephouse', candidates.length, this._verbose)
        }
        this._destructible.progress()
        for (const key of candidates) {
            const entries = []
            const child = await this.descend({ key }, entries)
            if (child.entry.value.items.length >= this.leaf.split) {
                await this._splitLeaf(key, child, entries)
            } else if (
                ! (
                    child.entry.value.id == '0.1' && child.entry.value.right == null
                ) &&
                child.entry.value.items.length <= this.leaf.merge
            ) {
                const merger = await this._selectMerger(key, child, entries)
                entries.forEach(entry => entry.release())
                if (merger != null) {
                    await this._mergeLeaf(merger)
                }
            } else {
                entries.forEach(entry => entry.release())
            }
        }
    }
}

module.exports = Sheaf
