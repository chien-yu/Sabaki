const EventEmitter = require('events')
const {dirname, resolve} = require('path')
const Board = require('@sabaki/go-board')
const gtp = require('@sabaki/gtp')
const sgf = require('@sabaki/sgf')
const argvsplit = require('argv-split')
const gametree = require('./gametree')
const helper = require('./helper')

const alpha = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
const defaultStateJSON = JSON.stringify({
    dirty: true,
    komi: null,
    size: null,
    moves: []
})

function parseVertex(coord, size) {
    if (coord == null || coord === 'resign') return null
    if (coord === 'pass') return [-1, -1]

    let x = alpha.indexOf(coord[0].toUpperCase())
    let y = size - +coord.slice(1)

    return [x, y]
}

class EngineSyncer extends EventEmitter {
    constructor(engine) {
        super()

        let {path, args, commands} = engine

        this._busy = false
        this.engine = engine
        this.commands = []
        this.state = JSON.parse(defaultStateJSON)

        this.controller = new gtp.Controller(path, argvsplit(args), {
            cwd: dirname(resolve(path))
        })

        this.controller.on('started', () => {
            Promise.all([
                this.controller.sendCommand({name: 'name'}),
                this.controller.sendCommand({name: 'version'}),
                this.controller.sendCommand({name: 'protocol_version'}),
                this.controller.sendCommand({name: 'list_commands'}).then(response => {
                    this.commands = response.content.split('\n')
                }),
                ...(
                    commands != null
                    && commands.trim() !== ''
                    ? commands.split(';').filter(x => x.trim() !== '').map(command =>
                        this.controller.sendCommand(gtp.Command.fromString(command))
                    )
                    : []
                )
            ]).catch(helper.noop)
        })

        this.controller.on('stopped', () => {
            this.state = JSON.parse(defaultStateJSON)
            this.busy = false
        })

        this.controller.on('command-sent', async ({command, getResponse, subscribe}) => {
            // Track engine state

            let res = null

            this.busy = this.controller.busy

            if (!['lz-genmove_analyze', 'genmove_analyze'].includes(command.name)) {
                try {
                    res = await getResponse()
                    if (res.error) return
                } catch (err) {
                    return
                }
            }

            if (command.name === 'boardsize' && command.args.length >= 1) {
                this.state.size = +command.args[0]
                this.state.dirty = true
            } else if (command.name === 'clear_board') {
                this.state.moves = []
                this.state.dirty = false
            } else if (command.name === 'komi' && command.args.length >= 1) {
                this.state.komi = +command.args[0]
            } else if (['fixed_handicap', 'place_free_handicap'].includes(command.name)) {
                let vertices = res.content.trim().split(/\s+/)
                    .map(coord => parseVertex(coord, this.state.size))
                    .filter(x => x != null)

                if (vertices.length > 0) this.state.moves.push({sign: 1, vertices})
            } else if (command.name === 'set_free_handicap') {
                let vertices = command.args
                    .map(coord => parseVertex(coord, this.state.size))
                    .filter(x => x != null)

                if (vertices.length > 0) this.state.moves.push({sign: 1, vertices})
            } else if (command.name === 'play' && command.args.length >= 2) {
                let sign = command.args[0][0].toLowerCase() === 'w' ? -1 : 1
                let vertex = parseVertex(command.args[1], this.state.size)

                if (vertex) this.state.moves.push({sign, vertex})
            } else if (
                [
                    'genmove',
                    'lz-genmove_analyze',
                    'genmove_analyze'
                ].includes(command.name) && command.args.length >= 1
            ) {
                let sign = command.args[0][0].toLowerCase() === 'w' ? -1 : 1
                let coord = !command.name.includes('analyze')
                    ? res.content.trim()
                    : await new Promise(resolve => {
                        getResponse()
                        .then(() => resolve(null))
                        .catch(() => resolve(null))

                        subscribe(({line}) => {
                            let match = line.trim().match(/^play (.*)$/)
                            if (match) resolve(match[1])
                        })
                    })

                let vertex = parseVertex(coord, this.state.size)
                if (vertex) this.state.moves.push({sign, vertex})
            } else if (command.name === 'undo') {
                this.state.moves.length -= 1
            } else if (command.name === 'loadsgf') {
                this.state.dirty = true
            }
        })

        this.controller.on('response-received', () => {
            this.busy = this.controller.busy
        })
    }

    get busy() {
        return this._busy
    }

    set busy(value) {
        if (value !== this._busy) {
            this._busy = value
            this.emit('busy-changed')
        }
    }

    async sync(tree, id) {
        let controller = this.controller
        let board = gametree.getBoard(tree, id)

        if (!board.isSquare()) {
            throw new Error('GTP engines don’t support non-square boards.')
        } else if (!board.isValid()) {
            throw new Error('GTP engines don’t support invalid board positions.')
        } else if (board.width > alpha.length) {
            throw new Error(`GTP engines only support board sizes that don’t exceed ${alpha.length}.`)
        }

        // Update komi

        let komi = +gametree.getRootProperty(tree, 'KM', 0)

        if (komi !== this.state.komi) {
            let {error} = await controller.sendCommand({name: 'komi', args: [komi]})
            if (error) throw new Error('Komi is not supported by engine.')
        }

        // Update board size

        if (this.state.dirty || board.width !== this.state.size) {
            let {error} = await controller.sendCommand({name: 'boardsize', args: [board.width]})
            if (error) throw new Error('Board size is not supported by engine.')

            this.state.dirty = true
        }

        // Replay

        async function enginePlay(sign, vertex) {
            let color = sign > 0 ? 'B' : 'W'
            let coord = board.stringifyVertex(vertex)
            if (coord == null) coord = 'pass'

            try {
                let {error} = await controller.sendCommand({name: 'play', args: [color, coord]})
                if (error) return false
            } catch (err) {
                return false
            }

            return true
        }

        let engineBoard = Board.fromDimensions(board.width, board.height)
        let moves = []
        let promises = []
        let synced = true
        let nodes = [...tree.listNodesVertically(id, -1, {})].reverse()

        for (let node of nodes) {
            let nodeBoard = gametree.getBoard(tree, node.id)
            let placedHandicapStones = false

            if (
                node.data.AB
                && node.data.AB.length >= 2
                && engineBoard.isEmpty()
                && this.commands.includes('set_free_handicap')
            ) {
                // Place handicap stones

                let vertices = [].concat(...node.data.AB.map(sgf.parseCompressedVertices)).sort()
                let coords = vertices
                    .map(v => board.stringifyVertex(v))
                    .filter(x => x != null)
                    .filter((x, i, arr) => i === 0 || x !== arr[i - 1])

                if (coords.length > 0) {
                    moves.push({sign: 1, vertices})
                    promises.push(() =>
                        controller
                        .sendCommand({name: 'set_free_handicap', args: coords})
                        .then(r => !r.error)
                    )

                    for (let vertex of vertices) {
                        if (engineBoard.get(vertex) !== 0) continue

                        engineBoard = engineBoard.makeMove(1, vertex)
                    }

                    placedHandicapStones = true
                }
            }

            for (let prop of ['B', 'W', 'AB', 'AW']) {
                if (node.data[prop] == null || placedHandicapStones && prop === 'AB') continue

                let sign = prop.slice(-1) === 'B' ? 1 : -1
                let vertices = [].concat(...node.data[prop].map(sgf.parseCompressedVertices))

                for (let vertex of vertices) {
                    if (engineBoard.has(vertex) && engineBoard.get(vertex) !== 0) continue
                    else if (!engineBoard.has(vertex)) vertex = [-1, -1]

                    moves.push({sign, vertex})
                    promises.push(() => enginePlay(sign, vertex))
                    engineBoard = engineBoard.makeMove(sign, vertex)
                }
            }

            if (!helper.equals(engineBoard.signMap, nodeBoard.signMap)) {
                synced = false
                break
            }

            if (node.id === id) break
        }

        if (synced) {
            let sharedHistoryLength = [...Array(Math.min(this.state.moves.length, moves.length))]
                .findIndex((_, i) => !helper.equals(moves[i], this.state.moves[i]))
            if (sharedHistoryLength < 0) sharedHistoryLength = Math.min(this.state.moves.length, moves.length)
            let undoLength = this.state.moves.length - sharedHistoryLength

            if (
                !this.state.dirty
                && sharedHistoryLength > 0
                && undoLength < sharedHistoryLength
                && (this.commands.includes('undo') || undoLength === 0)
            ) {
                // Undo until shared history is reached, then play out rest

                promises = [
                    ...[...Array(undoLength)].map(() =>
                        () => controller.sendCommand({name: 'undo'}).then(r => !r.error)
                    ),
                    ...promises.slice(sharedHistoryLength)
                ]
            } else {
                // Replay from beginning

                promises.unshift(() => controller.sendCommand({name: 'clear_board'}))
            }

            let result = await Promise.all(promises.map(x => x()))
            let success = result.every(x => x)
            if (success) return
        }

        // Incremental rearrangement

        if (!this.state.dirty) {
            promises = []
            engineBoard = Board.fromDimensions(board.width, board.height)

            for (let {sign, vertex} of this.state.moves) {
                engineBoard = engineBoard.makeMove(sign, vertex)
            }

            let diff = engineBoard.diff(board).filter(v => board.get(v) !== 0)

            for (let vertex of diff) {
                let sign = board.get(vertex)

                promises.push(() => enginePlay(sign, vertex))
                engineBoard = engineBoard.makeMove(board.get(vertex), vertex)
            }

            if (helper.equals(engineBoard.signMap, board.signMap)) {
                let result = await Promise.all(promises.map(x => x()))
                let success = result.every(x => x)
                if (success) return
            }
        }

        // Complete rearrangement

        promises = [() => controller.sendCommand({name: 'clear_board'})]
        engineBoard = Board.fromDimensions(board.width, board.height)

        for (let x = 0; x < board.width; x++) {
            for (let y = 0; y < board.height; y++) {
                let vertex = [x, y]
                let sign = board.get(vertex)
                if (sign === 0) continue

                promises.push(() => enginePlay(sign, vertex))
                engineBoard = engineBoard.makeMove(sign, vertex)
            }
        }

        if (helper.equals(engineBoard.signMap, board.signMap)) {
            let result = await Promise.all(promises.map(x => x()))
            let success = result.every(x => x)
            if (success) return
        }

        throw new Error('Current board arrangement can’t be recreated on the GTP engine.')
    }
}

module.exports = EngineSyncer
