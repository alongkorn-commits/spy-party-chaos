import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distPath = path.resolve(__dirname, '../dist')
const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
})

const PORT = Number(process.env.PORT || 3001)
const CHAT_PHASE_MS = 90000
const VOTING_PHASE_MS = 30000
const ROOM_IDLE_MS = 5 * 60 * 1000
const MIN_PLAYERS = 3
const rooms = new Map()

const chaosEvents = [
  'Chaos event: everyone must speak in one word for the next 15 seconds.',
  'Chaos event: dramatic silence. No talking for the next 10 seconds.',
  'Chaos event: accuse someone without using their name.',
  'Chaos event: answer the next question as if you are in a hurry.',
]

const scenarioPool = [
  {
    location: 'abandoned spaceship',
    roles: ['engineer', 'pilot', 'scientist', 'security officer', 'stowaway', 'medic'],
    hint: 'Something is drifting where it should not exist.',
  },
  {
    location: 'luxury submarine',
    roles: ['captain', 'chef', 'navigator', 'mechanic', 'tour guide', 'deep sea researcher'],
    hint: 'The walls groan and everyone pretends that is normal.',
  },
  {
    location: 'haunted film set',
    roles: ['director', 'camera operator', 'makeup artist', 'lead actor', 'stunt coordinator', 'sound designer'],
    hint: 'Every shadow looks rehearsed until it moves on its own.',
  },
  {
    location: 'volcanic spa resort',
    roles: ['lifeguard', 'massage therapist', 'tourist', 'yoga instructor', 'geologist', 'bartender'],
    hint: 'Relaxation feels dangerous here.',
  },
  {
    location: 'floating black market',
    roles: ['auctioneer', 'bodyguard', 'smuggler', 'collector', 'mechanic', 'lookout'],
    hint: 'Everything is for sale and nothing is legal.',
  },
  {
    location: 'time travel airport',
    roles: ['pilot', 'historian', 'customs agent', 'mechanic', 'tourist', 'timeline inspector'],
    hint: 'Arrivals and departures are not in the same century.',
  },
  {
    location: 'underwater research dome',
    roles: ['marine biologist', 'dive supervisor', 'robotics specialist', 'doctor', 'intern', 'communications officer'],
    hint: 'A crack would end the conversation quickly.',
  },
  {
    location: 'monster theme park',
    roles: ['ride operator', 'mascot', 'janitor', 'ticket collector', 'animatronics engineer', 'park manager'],
    hint: 'The fake screams and real screams are hard to separate.',
  },
]

const allLocations = scenarioPool.map((scenario) => scenario.location)

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)]
}

function randomId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

function normalizeLocation(value) {
  return value?.trim().toLowerCase()
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code

  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  } while (rooms.has(code))

  return code
}

function generateScenario(playerCount) {
  const base = randomItem(scenarioPool)
  const roles = [...base.roles]
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.max(1, playerCount - 1))

  return {
    location: base.location,
    roles,
    hint: base.hint,
  }
}

function createPlayer({ socketId, sessionId, name, isHost = false }) {
  return {
    id: randomId('player'),
    sessionId,
    socketId,
    name: name.trim(),
    isHost,
    isSpy: false,
    role: null,
    connected: true,
    guessedLocation: false,
  }
}

function createRoom(hostPlayer) {
  return {
    code: generateRoomCode(),
    hostId: hostPlayer.id,
    players: [hostPlayer],
    phase: 'lobby',
    scenario: null,
    messages: [],
    votes: {},
    result: null,
    round: 0,
    timerEndsAt: null,
    timerDurationMs: 0,
    timerHandle: null,
    cleanupHandle: null,
    chaosEvent: null,
    spyGuessUsed: false,
  }
}

function getPlayerRoom(playerId) {
  for (const room of rooms.values()) {
    const player = room.players.find((entry) => entry.id === playerId)
    if (player) {
      return { room, player }
    }
  }

  return { room: null, player: null }
}

function findPlayerBySessionId(sessionId) {
  if (!sessionId) {
    return { room: null, player: null }
  }

  for (const room of rooms.values()) {
    const player = room.players.find((entry) => entry.sessionId === sessionId)
    if (player) {
      return { room, player }
    }
  }

  return { room: null, player: null }
}

function getPlayerBySocket(socket) {
  const playerId = socket.data.playerId
  if (!playerId) {
    return { room: null, player: null }
  }

  return getPlayerRoom(playerId)
}

function connectedPlayers(room) {
  return room.players.filter((player) => player.connected)
}

function clearRoomTimer(room) {
  if (room.timerHandle) {
    clearTimeout(room.timerHandle)
    room.timerHandle = null
  }
}

function clearRoomCleanup(room) {
  if (room.cleanupHandle) {
    clearTimeout(room.cleanupHandle)
    room.cleanupHandle = null
  }
}

function scheduleRoomCleanup(room) {
  clearRoomCleanup(room)
  room.cleanupHandle = setTimeout(() => {
    const refreshedRoom = rooms.get(room.code)
    if (!refreshedRoom) {
      return
    }

    if (connectedPlayers(refreshedRoom).length === 0) {
      clearRoomTimer(refreshedRoom)
      rooms.delete(refreshedRoom.code)
    }
  }, ROOM_IDLE_MS)
}

function ensureHost(room) {
  const currentHost = room.players.find((player) => player.id === room.hostId)

  if (currentHost?.connected) {
    currentHost.isHost = true
    return currentHost
  }

  const nextHost = connectedPlayers(room)[0] || room.players[0] || null
  room.players.forEach((player) => {
    player.isHost = false
  })

  if (nextHost) {
    nextHost.isHost = true
    room.hostId = nextHost.id
  } else {
    room.hostId = null
  }

  return nextHost
}

function sanitizePlayer(player, room) {
  return {
    id: player.id,
    name: player.name,
    isHost: player.id === room.hostId,
    isSpy: room.phase === 'result' ? player.isSpy : undefined,
    connected: player.connected,
    hasVoted: room.phase === 'voting' || room.phase === 'result'
      ? Boolean(room.votes[player.id])
      : false,
  }
}

function getRoomSnapshot(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    players: room.players.map((player) => sanitizePlayer(player, room)),
    messages: room.messages,
    timerEndsAt: room.timerEndsAt,
    timerDurationMs: room.timerDurationMs,
    chaosEvent: room.chaosEvent,
    votedPlayerIds: Object.keys(room.votes),
    voteCount: Object.keys(room.votes).length,
    round: room.round,
    availableLocations: allLocations,
  }
}

function emitRoomState(room) {
  ensureHost(room)
  io.to(room.code).emit('roomState', getRoomSnapshot(room))
}

function buildPrivateRolePayload(room, player) {
  if (room.phase === 'lobby' || !room.scenario) {
    return null
  }

  if (player.isSpy) {
    return {
      roleType: 'spy',
      message: 'YOU ARE SPY',
      hint: room.scenario.hint,
      guessUsed: player.guessedLocation,
      locationOptions: allLocations,
    }
  }

  return {
    roleType: 'civilian',
    location: room.scenario.location,
    role: player.role,
    hint: room.scenario.hint,
  }
}

function emitPrivateRole(room, player) {
  if (!player.socketId) {
    return
  }

  const payload = buildPrivateRolePayload(room, player)
  if (!payload) {
    io.to(player.socketId).emit('assignRole', null)
    return
  }

  io.to(player.socketId).emit('assignRole', payload)
}

function emitPrivateRoles(room) {
  room.players.forEach((player) => emitPrivateRole(room, player))
}

function createResultFromVotes(room) {
  const voteCounts = Object.values(room.votes).reduce((acc, targetId) => {
    acc[targetId] = (acc[targetId] || 0) + 1
    return acc
  }, {})

  let topTargetId = null
  let topVotes = 0
  let tie = false

  for (const [targetId, count] of Object.entries(voteCounts)) {
    if (count > topVotes) {
      topVotes = count
      topTargetId = targetId
      tie = false
    } else if (count === topVotes) {
      tie = true
    }
  }

  const spy = room.players.find((player) => player.isSpy)
  const accusedPlayer = room.players.find((player) => player.id === topTargetId) || null
  const civiliansWin = Boolean(spy) && accusedPlayer?.id === spy.id && !tie

  return {
    winningTeam: civiliansWin ? 'civilians' : 'spy',
    victoryType: civiliansWin ? 'vote-correct' : tie ? 'vote-tie' : 'vote-wrong',
    spyId: spy?.id || null,
    spyName: spy?.name || 'Unknown',
    accusedId: accusedPlayer?.id || null,
    accusedName: accusedPlayer?.name || 'No one',
    location: room.scenario?.location || 'Unknown',
    hint: room.scenario?.hint || '',
    roles: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      role: player.isSpy ? 'SPY' : player.role,
      isSpy: player.isSpy,
    })),
    votes: room.votes,
    summary: civiliansWin
      ? `The civilians exposed ${spy?.name || 'the spy'}.`
      : `${spy?.name || 'The spy'} escaped suspicion.`,
  }
}

function revealResult(room, overrideResult = null) {
  clearRoomTimer(room)
  room.phase = 'result'
  room.timerDurationMs = 0
  room.timerEndsAt = null
  room.result = overrideResult || createResultFromVotes(room)
  emitRoomState(room)
  io.to(room.code).emit('revealResult', room.result)
}

function beginVoting(room) {
  clearRoomTimer(room)
  room.phase = 'voting'
  room.timerDurationMs = VOTING_PHASE_MS
  room.timerEndsAt = Date.now() + VOTING_PHASE_MS
  room.messages.push({
    id: `system-${Date.now()}`,
    sender: 'SYSTEM',
    text: 'Voting has started. Pick the player you think is the spy.',
    type: 'system',
    createdAt: Date.now(),
  })
  emitRoomState(room)
  room.timerHandle = setTimeout(() => revealResult(room), VOTING_PHASE_MS)
}

function resetRoundState(room) {
  clearRoomTimer(room)
  room.phase = 'chat'
  room.round += 1
  room.messages = [
    {
      id: `system-${Date.now()}`,
      sender: 'SYSTEM',
      text: 'Round started. Blend in, interrogate, and stay sharp.',
      type: 'system',
      createdAt: Date.now(),
    },
  ]
  room.votes = {}
  room.result = null
  room.chaosEvent = randomItem(chaosEvents)
  room.scenario = generateScenario(room.players.length)
  room.spyGuessUsed = false
  room.timerDurationMs = CHAT_PHASE_MS
  room.timerEndsAt = Date.now() + CHAT_PHASE_MS

  const spyIndex = Math.floor(Math.random() * room.players.length)
  let civilianIndex = 0

  room.players.forEach((player, index) => {
    player.isSpy = index === spyIndex
    player.role = player.isSpy ? null : room.scenario.roles[civilianIndex++] || 'observer'
    player.guessedLocation = false
  })
}

function startRound(room) {
  if (room.players.length < MIN_PLAYERS) {
    throw new Error(`At least ${MIN_PLAYERS} players are required.`)
  }

  if (connectedPlayers(room).length !== room.players.length) {
    throw new Error('All players must be connected before starting the round.')
  }

  resetRoundState(room)
  emitRoomState(room)
  emitPrivateRoles(room)

  room.messages.push({
    id: `system-chaos-${Date.now()}`,
    sender: 'CHAOS',
    text: room.chaosEvent,
    type: 'chaos',
    createdAt: Date.now(),
  })
  emitRoomState(room)

  room.timerHandle = setTimeout(() => beginVoting(room), CHAT_PHASE_MS)
}

function ensureRoom(roomCode) {
  return rooms.get(roomCode?.toUpperCase())
}

function attachSocketToPlayer(socket, room, player) {
  clearRoomCleanup(room)
  socket.join(room.code)
  socket.data.roomCode = room.code
  socket.data.playerId = player.id
  socket.data.sessionId = player.sessionId
  player.socketId = socket.id
  player.connected = true
  emitRoomState(room)
}

function removePlayerFromRoom(room, playerId) {
  room.players = room.players.filter((player) => player.id !== playerId)
  delete room.votes[playerId]

  if (room.players.length === 0) {
    clearRoomTimer(room)
    clearRoomCleanup(room)
    rooms.delete(room.code)
    return
  }

  ensureHost(room)
  emitRoomState(room)
}

app.use(cors())
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size })
})

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(distPath))

  app.get('/', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

io.on('connection', (socket) => {
  socket.data.sessionId = socket.handshake.auth?.sessionId || randomId('session')

  const restored = findPlayerBySessionId(socket.data.sessionId)
  if (restored.room && restored.player) {
    attachSocketToPlayer(socket, restored.room, restored.player)
    socket.emit('sessionRestored', {
      roomCode: restored.room.code,
      playerId: restored.player.id,
      playerName: restored.player.name,
      sessionId: restored.player.sessionId,
    })
    emitPrivateRole(restored.room, restored.player)
    if (restored.room.result) {
      socket.emit('revealResult', restored.room.result)
    }
  }

  socket.on('createRoom', ({ playerName }, callback = () => {}) => {
    try {
      const trimmedName = playerName?.trim()

      if (!trimmedName) {
        throw new Error('Player name is required.')
      }

      const existing = getPlayerBySocket(socket)
      if (existing.room) {
        throw new Error('You are already in a room.')
      }

      const hostPlayer = createPlayer({
        socketId: socket.id,
        sessionId: socket.data.sessionId,
        name: trimmedName,
        isHost: true,
      })
      const room = createRoom(hostPlayer)

      rooms.set(room.code, room)
      attachSocketToPlayer(socket, room, hostPlayer)
      callback({
        ok: true,
        roomCode: room.code,
        playerId: hostPlayer.id,
        sessionId: hostPlayer.sessionId,
      })
    } catch (error) {
      callback({ ok: false, error: error.message })
    }
  })

  socket.on('joinRoom', ({ roomCode, playerName }, callback = () => {}) => {
    try {
      const room = ensureRoom(roomCode)
      const trimmedName = playerName?.trim()

      if (!room) {
        throw new Error('Room not found.')
      }

      if (!trimmedName) {
        throw new Error('Player name is required.')
      }

      const existing = getPlayerBySocket(socket)
      if (existing.room) {
        throw new Error('You are already in a room.')
      }

      if (room.phase !== 'lobby') {
        throw new Error('This room is already in a game.')
      }

      if (room.players.some((player) => player.name.toLowerCase() === trimmedName.toLowerCase())) {
        throw new Error('That name is already taken in this room.')
      }

      const player = createPlayer({
        socketId: socket.id,
        sessionId: socket.data.sessionId,
        name: trimmedName,
      })

      room.players.push(player)
      attachSocketToPlayer(socket, room, player)
      callback({
        ok: true,
        roomCode: room.code,
        playerId: player.id,
        sessionId: player.sessionId,
      })
    } catch (error) {
      callback({ ok: false, error: error.message })
    }
  })

  socket.on('startGame', ({ roomCode }, callback = () => {}) => {
    try {
      const room = ensureRoom(roomCode)
      const { player } = getPlayerBySocket(socket)

      if (!room || !player) {
        throw new Error('Room not found.')
      }

      if (room.hostId !== player.id) {
        throw new Error('Only the host can start the game.')
      }

      if (room.phase !== 'lobby') {
        throw new Error('The game has already started.')
      }

      startRound(room)
      callback({ ok: true })
    } catch (error) {
      callback({ ok: false, error: error.message })
    }
  })

  socket.on('nextRound', ({ roomCode }, callback = () => {}) => {
    try {
      const room = ensureRoom(roomCode)
      const { player } = getPlayerBySocket(socket)

      if (!room || !player) {
        throw new Error('Room not found.')
      }

      if (room.hostId !== player.id) {
        throw new Error('Only the host can start the next round.')
      }

      if (room.phase !== 'result') {
        throw new Error('The round is not over yet.')
      }

      startRound(room)
      callback({ ok: true })
    } catch (error) {
      callback({ ok: false, error: error.message })
    }
  })

  socket.on('sendMessage', ({ roomCode, message, reaction }, callback = () => {}) => {
    try {
      const room = ensureRoom(roomCode)
      const { player } = getPlayerBySocket(socket)

      if (!room || !player) {
        throw new Error('Room not found.')
      }

      if (room.phase !== 'chat') {
        throw new Error('Chat is only available during the chat phase.')
      }

      const text = message?.trim()
      if (!text && !reaction) {
        throw new Error('Message cannot be empty.')
      }

      const payload = {
        id: `${player.id}-${Date.now()}`,
        sender: player.name,
        senderId: player.id,
        text: text || reaction,
        reaction: reaction || null,
        type: reaction ? 'reaction' : 'chat',
        createdAt: Date.now(),
      }

      room.messages.push(payload)
      io.to(room.code).emit('sendMessage', payload)
      emitRoomState(room)
      callback({ ok: true })
    } catch (error) {
      callback({ ok: false, error: error.message })
    }
  })

  socket.on('guessLocation', ({ roomCode, location }, callback = () => {}) => {
    try {
      const room = ensureRoom(roomCode)
      const { player } = getPlayerBySocket(socket)

      if (!room || !player) {
        throw new Error('Room not found.')
      }

      if (room.phase !== 'chat') {
        throw new Error('Location guesses are only allowed during the chat phase.')
      }

      if (!player.isSpy) {
        throw new Error('Only the spy can guess the location.')
      }

      if (player.guessedLocation) {
        throw new Error('The spy has already used the location guess.')
      }

      if (!allLocations.includes(location)) {
        throw new Error('Invalid location guess.')
      }

      player.guessedLocation = true
      room.spyGuessUsed = true
      emitPrivateRole(room, player)

      if (normalizeLocation(location) === normalizeLocation(room.scenario?.location)) {
        revealResult(room, {
          winningTeam: 'spy',
          victoryType: 'spy-guess-correct',
          spyId: player.id,
          spyName: player.name,
          accusedId: null,
          accusedName: 'No accusation',
          location: room.scenario.location,
          hint: room.scenario.hint,
          roles: room.players.map((entry) => ({
            id: entry.id,
            name: entry.name,
            role: entry.isSpy ? 'SPY' : entry.role,
            isSpy: entry.isSpy,
          })),
          votes: room.votes,
          guessedLocation: location,
          summary: `${player.name} guessed the hidden location and stole the round.`,
        })
        callback({ ok: true, correct: true })
        return
      }

      callback({
        ok: true,
        correct: false,
        message: 'Wrong guess. The round continues, but the spy cannot guess again.',
      })
    } catch (error) {
      callback({ ok: false, error: error.message })
    }
  })

  socket.on('votePlayer', ({ roomCode, targetId }, callback = () => {}) => {
    try {
      const room = ensureRoom(roomCode)
      const { player } = getPlayerBySocket(socket)

      if (!room || !player) {
        throw new Error('Room not found.')
      }

      if (room.phase !== 'voting') {
        throw new Error('Voting is not active.')
      }

      if (!room.players.some((entry) => entry.id === targetId)) {
        throw new Error('Invalid vote target.')
      }

      room.votes[player.id] = targetId
      io.to(room.code).emit('votePlayer', { voterId: player.id, targetId })
      emitRoomState(room)

      if (room.players.every((entry) => room.votes[entry.id])) {
        revealResult(room)
      }

      callback({ ok: true })
    } catch (error) {
      callback({ ok: false, error: error.message })
    }
  })

  socket.on('revealResult', ({ roomCode }, callback = () => {}) => {
    try {
      const room = ensureRoom(roomCode)
      const { player } = getPlayerBySocket(socket)

      if (!room || !player) {
        throw new Error('Room not found.')
      }

      if (room.hostId !== player.id) {
        throw new Error('Only the host can reveal the result early.')
      }

      if (room.phase !== 'voting') {
        throw new Error('The round is not in voting.')
      }

      revealResult(room)
      callback({ ok: true })
    } catch (error) {
      callback({ ok: false, error: error.message })
    }
  })

  socket.on('leaveRoom', (_payload, callback = () => {}) => {
    try {
      const { room, player } = getPlayerBySocket(socket)

      if (!room || !player) {
        callback({ ok: true })
        return
      }

      removePlayerFromRoom(room, player.id)
      socket.leave(room.code)
      socket.data.roomCode = null
      socket.data.playerId = null
      callback({ ok: true })
    } catch (error) {
      callback({ ok: false, error: error.message })
    }
  })

  socket.on('disconnect', () => {
    const { room, player } = getPlayerBySocket(socket)
    if (!room || !player) {
      return
    }

    player.connected = false
    player.socketId = null

    if (room.hostId === player.id) {
      ensureHost(room)
    }

    if (connectedPlayers(room).length === 0) {
      scheduleRoomCleanup(room)
    }

    emitRoomState(room)
  })
})

httpServer.listen(PORT, () => {
  console.log(`Spy Party Chaos server listening on http://localhost:${PORT}`)
})
